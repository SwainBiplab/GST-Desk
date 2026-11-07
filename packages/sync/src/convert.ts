/**
 * Moving a business between "local only" and "synced" (prompt 41). Converting copies every row of the
 * business from the local book into the synced one, in an order no reference can trip over, in batches
 * that each become one upload; the server takes them like any upload (checked, priced again, numbered).
 * Leaving copies everything back into a local book, which then stands alone.
 */
import {
  NumberingRepo,
  SYNC_TABLES,
  isUploadableSetting,
  queryRows,
  tableInfo,
  tableOrder,
  type Ctx,
  type Database,
} from '@gst/db';
import { sql } from 'drizzle-orm';

export interface WritableBook {
  database: Database;
  writeTransaction<T>(
    fn: (tx: { execute(sql: string, params?: unknown[]): Promise<unknown> }) => Promise<T>,
  ): Promise<T>;
}

export interface CopyResult {
  tables: Record<string, number>;
  rows: number;
}

const BATCH = 400;

/** The tables a business is made of, parents first, that sync up. */
function businessTables(): string[] {
  const up = new Set(SYNC_TABLES.filter((t) => t.direction === 'both').map((t) => t.name));
  return tableOrder().filter((t) => up.has(t) && t !== 'memberships');
}

async function readBusiness(
  source: Database,
  table: string,
  businessId: string,
): Promise<Record<string, unknown>[]> {
  const where = table === 'businesses' ? sql`id = ${businessId}` : sql`business_id = ${businessId}`;
  const rows = await queryRows(
    source,
    source.db,
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${where}`,
  );
  // rows that point at another row of the same table (a ledger account's parent) go after that row
  const selfRef = Object.entries(tableInfo(table).refs).find(([, to]) => to === table)?.[0];
  if (!selfRef) return rows;
  const out: Record<string, unknown>[] = [];
  const placed = new Set<unknown>();
  let rest = rows;
  while (rest.length) {
    const next = rest.filter(
      (r) =>
        r[selfRef] == null || placed.has(r[selfRef]) || !rows.some((x) => x['id'] === r[selfRef]),
    );
    if (!next.length) return [...out, ...rest];
    for (const r of next) {
      out.push(r);
      placed.add(r['id']);
    }
    rest = rest.filter((r) => !placed.has(r['id']));
  }
  return out;
}

const insertSql = (table: string, cols: string[]) =>
  `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;

const sqliteValue = (v: unknown) =>
  typeof v === 'boolean'
    ? v
      ? 1
      : 0
    : v !== null && typeof v === 'object'
      ? JSON.stringify(v)
      : v;

/**
 * Copy a local business into a synced book under the cloud organisation. Each batch is one local
 * transaction and so one upload. The business is then marked synced, so devices take numbers from ranges.
 */
export async function uploadBusiness(
  source: Database,
  sourceCtx: Ctx,
  book: WritableBook,
  cloud: { orgId: string; deviceId: string; actor: string },
): Promise<CopyResult> {
  const result: CopyResult = { tables: {}, rows: 0 };
  const write = async (
    table: string,
    rows: Record<string, unknown>[],
    tx: { execute(sql: string, params?: unknown[]): Promise<unknown> },
  ) => {
    const cols = Object.keys(tableInfo(table).columns);
    const hasOrg = 'org_id' in tableInfo(table).columns;
    for (const r of rows) {
      const row: Record<string, unknown> = { ...r, ...(hasOrg ? { org_id: cloud.orgId } : {}) };
      await tx.execute(
        insertSql(table, cols),
        cols.map((c) => sqliteValue(row[c] ?? null)),
      );
    }
  };
  // lines travel with their document: the server prices a document from the lines in the same upload
  const allLines = await readBusiness(source, 'document_lines', sourceCtx.businessId);
  const linesOf = new Map<unknown, Record<string, unknown>[]>();
  for (const l of allLines)
    linesOf.set(l['document_id'], [...(linesOf.get(l['document_id']) ?? []), l]);

  for (const table of businessTables()) {
    if (table === 'document_lines') continue;
    let rows = await readBusiness(source, table, sourceCtx.businessId);
    if (table === 'settings')
      rows = rows.filter((r) => isUploadableSetting(String(r['key'] ?? '')));
    if (!rows.length) continue;
    const per = table === 'documents' ? 50 : BATCH;
    for (let i = 0; i < rows.length; i += per) {
      const slice = rows.slice(i, i + per);
      await book.writeTransaction(async (tx) => {
        await write(table, slice, tx);
        if (table === 'documents')
          for (const d of slice) await write('document_lines', linesOf.get(d['id']) ?? [], tx);
      });
    }
    result.tables[table] = rows.length;
    result.rows += rows.length;
  }
  result.tables['document_lines'] = allLines.length;
  result.rows += allLines.length;
  await new NumberingRepo(book.database).setMode(
    {
      orgId: cloud.orgId,
      businessId: sourceCtx.businessId,
      actor: cloud.actor,
      deviceId: cloud.deviceId,
    },
    'synced',
  );
  return result;
}

/**
 * Copy a synced business into a local book that will stand alone: every row, the organisation kept (a
 * local organisation row is made for it), and the business marked local again.
 */
export async function detachBusiness(
  book: Database,
  ctx: Ctx,
  target: Database,
  orgName = 'My organisation',
): Promise<CopyResult> {
  const result: CopyResult = { tables: {}, rows: 0 };
  await target.db.transaction(async (tx: any) => {
    await tx.run(
      sql`INSERT OR IGNORE INTO organisations (id, name, plan, version, created_at, updated_at) VALUES (${ctx.orgId}, ${orgName}, 'free', 1, ${Date.now()}, ${Date.now()})`,
    );
    for (const table of businessTables()) {
      const rows = await readBusiness(book, table, ctx.businessId);
      if (!rows.length) continue;
      const cols = Object.keys(tableInfo(table).columns);
      for (const r of rows) {
        const values = cols.map((c) => sqliteValue(r[c] ?? null));
        const parts = sql.join(
          values.map((v) => sql`${v}`),
          sql`, `,
        );
        await tx.run(
          sql`INSERT INTO ${sql.identifier(table)} (${sql.join(
            cols.map((c) => sql.identifier(c)),
            sql`, `,
          )}) VALUES (${parts})`,
        );
      }
      result.tables[table] = rows.length;
      result.rows += rows.length;
    }
  });
  await new NumberingRepo(target).setMode(ctx, 'local');
  return result;
}

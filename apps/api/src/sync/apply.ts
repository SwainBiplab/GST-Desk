/**
 * The server's half of sync (prompt 41): a device uploads the local transactions PowerSync queued; each
 * is applied to Postgres in one database transaction, as the app role with the organisation set, so
 * row-level security and the delete guards hold. Postgres is the source of truth once it is applied.
 *
 * Merge rules, decided per transaction (a draft save is one transaction: the document and its lines):
 * - The device says which version of a row it edited (`version` goes up by one on every local write). If
 *   the server still has that version, the change applies.
 * - If someone else changed the row since, fields that are not money (notes, terms, names, phone...) are
 *   merged column by column, last writer wins.
 * - Money and identity of a draft, or a soft delete racing a newer edit, make the whole transaction a
 *   conflict: nothing is applied and a `sync_conflict` inbox item keeps both versions for a person.
 * - An issued document's money and identity change only through a revision (`revision` up by one);
 *   a cancelled one never. Lines of an issued document change only with that revision.
 * - Every document the transaction touched is priced again by the engine; a total the engine does not
 *   agree with rejects the transaction.
 * - A document issued offline with a provisional number gets the next real number here, and a number
 *   that clashes with one already used is replaced the same way; the mapping is audited.
 */
import {
  DOCUMENT_FINANCIAL,
  DocumentFlowRepo,
  LINE_FINANCIAL_TABLES,
  ReviewRepo,
  SPEC,
  isUploadableSetting,
  newId,
  recomputeErrors,
  consistencyValidator,
  runInTx,
  syncTable,
  tableColumns,
  writeAudit,
  type Ctx,
  type Row,
} from '@gst/db';
import {
  can,
  canWriteAnything,
  changeAction,
  documentModule,
  MODULE_ACTIONS,
  needsApproval,
  tableAccess,
  type ApprovalPolicy,
  type Module,
  type Permissions,
} from '@gst/domain';
import { isProvisional } from '@gst/domain';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { PgDatabase } from '../db/pool';

export const crudOpSchema = z.object({
  op: z.enum(['PUT', 'PATCH', 'DELETE']),
  table: z.string().regex(/^[a-z_0-9]{1,64}$/),
  id: z.string().min(1).max(64),
  data: z.record(z.string(), z.unknown()).optional(),
  /** The row's version and time on the device before this change (what the change was made on top of). */
  previous: z.record(z.string(), z.unknown()).optional(),
});
export type CrudOp = z.infer<typeof crudOpSchema>;

export const clientTxSchema = z.object({
  /** PowerSync's transaction id on the device: with the device id, the key that makes a retry harmless. */
  txId: z.number().int().nonnegative(),
  ops: z.array(crudOpSchema).min(1).max(5_000),
});
export type ClientTx = z.infer<typeof clientTxSchema>;

export type TxOutcome =
  | {
      txId: number;
      outcome: 'applied';
      renumbered: { id: string; from: string; to: string }[];
      events: AppliedEvents;
    }
  | { txId: number; outcome: 'duplicate' }
  | { txId: number; outcome: 'conflict'; reviewItemId: string; reason: string }
  | { txId: number; outcome: 'approval'; reviewItemId: string; reason: string }
  | { txId: number; outcome: 'rejected'; reason: string };

/** What a transaction did that other services act on (prompt 44): documents newly issued, payments newly recorded. */
export interface AppliedEvents {
  issued: { id: string; businessId: string }[];
  payments: { id: string; businessId: string; date: string }[];
}

export interface SyncCaller {
  orgId: string;
  userId: string;
  deviceId: string;
  perms: Permissions;
  policy: ApprovalPolicy;
  /** Set when an approver lets a held transaction through: the approval gate is passed. */
  approvedBy?: string;
}

export class Rejected extends Error {}
/** A change the organisation wants an approver to see first (cancellation, revision of an issued document). */
class NeedsApproval extends Error {
  constructor(
    readonly module: Module,
    readonly change: 'cancel' | 'revise',
    readonly rowId: string,
    readonly businessId: string,
    readonly theirs: Record<string, unknown>,
    message: string,
  ) {
    super(message);
  }
}
export class Conflict extends Error {
  constructor(
    readonly table: string,
    readonly rowId: string,
    readonly businessId: string,
    readonly mine: Record<string, unknown>,
    readonly theirs: Record<string, unknown>,
    message: string,
  ) {
    super(message);
  }
}

const BOOKKEEPING = new Set(['version', 'updated_at', 'updated_by']);
const SPECS = new Map(SPEC.map((s) => [s.name, s]));

/** A value as SQLite (and so the device) holds it, made into what the Postgres column takes. */
function coerce(table: string, column: string, value: unknown): unknown {
  const spec = SPECS.get(table)!;
  const col = tableColumns(spec)[column];
  if (!col) throw new Rejected(`${table}.${column} is not a column`);
  if (value === null || value === undefined) return null;
  switch (col.kind) {
    case 'bool':
      return value === true || value === 1 || value === '1' || value === 'true';
    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    case 'int':
    case 'big':
    case 'ts': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) throw new Rejected(`${table}.${column} must be a number`);
      return Math.trunc(n);
    }
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

function coerceAll(table: string, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = coerce(table, k, v);
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function applyClientTx(
  d: PgDatabase,
  caller: SyncCaller,
  ctx0: Ctx,
  ctxTx: ClientTx,
): Promise<TxOutcome> {
  const ctx: Ctx = {
    ...ctx0,
    orgId: caller.orgId,
    actor: caller.userId,
    deviceId: caller.deviceId,
  };
  // retried uploads (the device did not hear the answer) are answered from the record
  const [seen] = await d.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${caller.orgId}, true)`;
    return tx`SELECT outcome FROM sync_applied WHERE device_id = ${caller.deviceId} AND client_tx_id = ${ctxTx.txId}`;
  });
  if (seen) return { txId: ctxTx.txId, outcome: 'duplicate' };

  try {
    const { renumbered, events } = await runInTx(
      d,
      { ...ctx, businessId: ctx.businessId || 'sync' },
      (tx) => applyOps(d, tx, ctx, caller, ctxTx),
      { allowNoBusiness: true },
    );
    await record(d, caller, ctxTx.txId, 'applied');
    return { txId: ctxTx.txId, outcome: 'applied', renumbered, events };
  } catch (e) {
    if (e instanceof NeedsApproval) {
      const item = await raiseApproval(d, ctx, caller, ctxTx, e);
      await resend(d, caller, ctxTx);
      await record(d, caller, ctxTx.txId, 'approval');
      return { txId: ctxTx.txId, outcome: 'approval', reviewItemId: item, reason: e.message };
    }
    if (e instanceof Conflict) {
      const item = await raiseConflict(d, ctx, caller, ctxTx, e);
      await resend(d, caller, ctxTx);
      await record(d, caller, ctxTx.txId, 'conflict');
      return { txId: ctxTx.txId, outcome: 'conflict', reviewItemId: item, reason: e.message };
    }
    // the database refusing the data (a check, a guard, a missing reference) will refuse it every time:
    // that is a rejection, not something to retry forever
    const refused = refusalOf(e);
    const rejected = refused ? new Rejected(refused) : e;
    // anything else (a lost race on a counter, the database going away) is not the device's fault: the
    // upload fails as a whole and PowerSync sends it again
    if (!(rejected instanceof Rejected)) throw e;
    await resend(d, caller, ctxTx);
    await record(d, caller, ctxTx.txId, 'rejected');
    return { txId: ctxTx.txId, outcome: 'rejected', reason: rejected.message };
  }
}

/**
 * After a conflict or a rejection the device still holds what it wrote. Send the server's version back
 * down: rows the server has are rewritten unchanged (a new row version, so the stream carries them again
 * and the device's copy is replaced); rows only the device made are stored deleted, so they arrive
 * deleted and drop out of every list. A row the database will not take that way is left as it is; the
 * status sheet still shows the rejection.
 */
export async function resend(d: PgDatabase, caller: SyncCaller, ctxTx: ClientTx): Promise<void> {
  const seen = new Set<string>();
  for (const op of ctxTx.ops) {
    const key = `${op.table}:${op.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const spec = SPECS.get(op.table);
    if (!spec || !('deleted_at' in tableColumns(spec))) continue;
    try {
      await d.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${caller.orgId}, true)`;
        const touched = await tx.unsafe(
          `UPDATE "${op.table}" SET version = version WHERE id = $1`,
          [op.id],
        );
        if (touched.count > 0 || op.op !== 'PUT' || !op.data) return;
        const row: Record<string, unknown> = {
          ...coerceAll(op.table, op.data),
          id: op.id,
          deleted_at: Date.now(),
        };
        if (spec.kind !== 'plain') row['org_id'] = caller.orgId;
        const cols = Object.keys(row);
        const values = cols.map((c) => {
          const v = row[c];
          return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
        });
        await tx.unsafe(
          `INSERT INTO "${op.table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (id) DO NOTHING`,
          values as never[],
        );
      });
    } catch {
      // best effort, see above
    }
  }
}

/**
 * A Postgres error that says the data itself is not acceptable: integrity (23xxx), bad data (22xxx) or a
 * trigger's RAISE (P0001). Serialisation failures, deadlocks and connection errors are not in the list.
 */
function refusalOf(e: unknown): string | null {
  for (
    let x: unknown = e, depth = 0;
    x && depth < 4;
    x = (x as { cause?: unknown }).cause, depth++
  ) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string' && (/^2[23]/.test(code) || code === 'P0001')) {
      const msg = (x as { message?: string }).message ?? code;
      return `the server refused the data: ${msg}`;
    }
  }
  return null;
}

async function record(d: PgDatabase, caller: SyncCaller, txId: number, outcome: string) {
  await d.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${caller.orgId}, true)`;
    await tx`INSERT INTO sync_applied (device_id, client_tx_id, org_id, outcome, at) VALUES (${caller.deviceId}, ${txId}, ${caller.orgId}, ${outcome}, ${Date.now()}) ON CONFLICT DO NOTHING`;
  });
}

export async function applyOps(
  d: PgDatabase,
  tx: any,
  ctx: Ctx,
  caller: SyncCaller,
  ctxTx: ClientTx,
): Promise<{ renumbered: { id: string; from: string; to: string }[]; events: AppliedEvents }> {
  const touchedDocs = new Set<string>();
  // documents made in this upload, and documents revised in it: their lines may be written with them
  const revisedDocs = new Set<string>();
  const revisedNow = new Set<string>();
  const issuedNow = new Set<string>();
  const paymentsNow: { id: string; businessId: string; date: string }[] = [];
  const issuedBiz = new Map<string, string>();
  const businessOf = new Map<string, string>();

  await authorise(d, tx, caller, ctxTx);

  // documents first in the order the device wrote them, so a line can see its document's new state
  for (const op of ctxTx.ops) {
    const meta = syncTable(op.table);
    if (!meta || meta.direction !== 'both') throw new Rejected(`${op.table} does not sync up`);

    const t = d.schema[op.table as keyof typeof d.schema];
    const [current]: Row[] = await tx
      .select()
      .from(t)
      .where(eq(t.id, op.id))
      .limit(1)
      .for('update');
    const owned = new Set<string>(meta.serverOwned);
    const data = Object.fromEntries(
      Object.entries(op.data ? coerceAll(op.table, op.data) : {}).filter(([k]) => !owned.has(k)),
    );
    if ('org_id' in data && data['org_id'] !== caller.orgId)
      throw new Rejected('the row belongs to another organisation');

    const businessId = String(
      data['business_id'] ??
        current?.['business_id'] ??
        (op.table === 'businesses' ? op.id : '') ??
        '',
    );
    if (meta.kind === 'tenant' || meta.kind === 'tenant-lite') {
      if (!businessId) {
        // a change to a row the server never got (it was in an upload that became a conflict): keep the
        // whole transaction for a person rather than lose what else it holds
        const home =
          [...businessOf.keys()][0] ??
          ctxTx.ops.map((o) => o.data?.['business_id']).find((x) => typeof x === 'string');
        if (op.op === 'PATCH' && home)
          throw new Conflict(
            op.table,
            op.id,
            String(home),
            data,
            {},
            'changes a row the server does not have (an earlier change to it is waiting in the inbox)',
          );
        throw new Rejected(`${op.table} ${op.id} has no business`);
      }
      if (!businessOf.has(businessId)) {
        const b = d.schema.businesses;
        const [biz] = await tx
          .select({ id: b.id })
          .from(b)
          .where(and(eq(b.id, businessId), eq(b.org_id, caller.orgId)))
          .limit(1);
        if (!biz) throw new Rejected('that business is not in this organisation');
        businessOf.set(businessId, businessId);
      }
      if (current && current['business_id'] !== businessId)
        throw new Rejected('a row cannot move to another business');
    }
    if (op.table === 'settings') {
      const key = String(data['key'] ?? current?.['key'] ?? '');
      if (!isUploadableSetting(key)) throw new Rejected('secret settings do not sync');
    }
    if (meta.appendOnly && (op.op !== 'PUT' || current))
      throw new Rejected(`${op.table} only takes new rows`);
    if (
      op.table === 'audit_log' &&
      data['actor'] !== caller.userId &&
      !String(data['actor'] ?? '').startsWith('system')
    ) {
      // the local repositories stamp the person; an upload cannot write in someone else's name
      data['actor'] = caller.userId;
    }

    if (op.op === 'DELETE') {
      if (!current) continue;
      // only rows already in the trash may be removed; the database's guard says the same
      if (current['deleted_at'] == null)
        throw new Rejected(`${op.table} ${op.id} is not in the trash`);
      await tx.delete(t).where(eq(t.id, op.id));
      continue;
    }

    if (op.table === 'documents') touchedDocs.add(op.id);
    if (LINE_FINANCIAL_TABLES.has(op.table))
      touchedDocs.add(String(data['document_id'] ?? current?.['document_id']));

    if (!current) {
      if (op.op === 'PATCH')
        throw new Conflict(
          op.table,
          op.id,
          businessId,
          data,
          {},
          'changes a row the server does not have (an earlier change to it is waiting in the inbox)',
        );
      if (LINE_FINANCIAL_TABLES.has(op.table))
        await assertLineWritable(d, tx, String(data['document_id']), revisedDocs);
      const row: Record<string, unknown> = { ...data, id: op.id };
      if (meta.kind !== 'plain') row['org_id'] = caller.orgId;
      // a document arriving already issued is history (conversion, import): it is checked, not re-priced
      if (op.table === 'documents') revisedDocs.add(op.id);
      await tx.insert(t).values(row);
      if (op.table === 'payments' && row['status'] !== 'cancelled' && row['direction'] !== 'made')
        paymentsNow.push({ id: op.id, businessId, date: String(row['date'] ?? '') });
      continue;
    }

    // PUT of an existing row (a retried insert): treat as a change of every column it carries
    const changed = Object.keys(data).filter(
      (k) => k !== 'id' && !BOOKKEEPING.has(k) && !same(data[k], current[k]),
    );
    const sentVersion = typeof data['version'] === 'number' ? (data['version'] as number) : null;
    // made on top of what the server holds? The version and time the device started from must both match:
    // two devices count versions on their own, so the number alone can coincide
    const prev = op.previous;
    const concurrent =
      prev && 'version' in prev && 'updated_at' in prev
        ? Number(prev['version']) !== Number(current['version']) ||
          Number(prev['updated_at']) !== Number(current['updated_at'])
        : (sentVersion === null ? Number(current['version']) : sentVersion - 1) !==
          Number(current['version']);
    const patch: Record<string, unknown> = {};
    for (const k of changed) patch[k] = data[k];

    if (op.table === 'documents') {
      const status = String(current['status']);
      const financial = changed.filter((k) =>
        (DOCUMENT_FINANCIAL as readonly string[]).includes(k),
      );
      const revising =
        Number(data['revision'] ?? current['revision']) === Number(current['revision'] ?? 1) + 1;
      // two devices worked on one document at once (both issued one shared draft, a revision raced a
      // cancellation): a conflict a person settles, whatever the server holds now
      if (
        concurrent &&
        (financial.length || (status === 'draft' && changed.some((k) => k === 'status')))
      )
        throw new Conflict(
          'documents',
          op.id,
          businessId,
          data,
          current,
          'the document was changed on another device',
        );
      if (status === 'cancelled' && (financial.length || data['status'] === 'issued'))
        throw new Rejected('a cancelled document cannot change');
      if (
        status === 'issued' &&
        financial.length &&
        !revising &&
        !(
          financial.length === 1 &&
          financial[0] === 'number' &&
          isProvisional(String(current['number']))
        )
      )
        throw new Rejected(
          `an issued document changes only through a revision (${financial.join(', ')}; was ${current['number']} v${current['version']} ${current['status']}, sent ${String(data['number'])} v${String(data['version'])} ${String(data['status'] ?? '')} ops ${ctxTx.ops.map((o) => o.op + ':' + o.table).join(' ')})`,
        );
      if (revising) {
        revisedDocs.add(op.id);
        revisedNow.add(op.id);
      }
      if (status === 'draft' && data['status'] === 'issued') {
        issuedNow.add(op.id);
        issuedBiz.set(op.id, businessId);
      }
    } else if (LINE_FINANCIAL_TABLES.has(op.table)) {
      await assertLineWritable(d, tx, String(current['document_id']), revisedDocs);
      if (concurrent && changed.length)
        throw new Conflict(
          op.table,
          op.id,
          businessId,
          data,
          current,
          'a line was changed on another device',
        );
    }

    // a draft discarded here but issued on another device stays issued; the discard is kept for a person
    if (
      op.table === 'documents' &&
      'deleted_at' in patch &&
      patch['deleted_at'] != null &&
      current['status'] !== 'draft'
    )
      throw new Conflict(
        op.table,
        op.id,
        businessId,
        data,
        current,
        'discarded here, but issued on another device',
      );

    // a soft delete that races a newer edit loses; an older edit loses to the delete
    if ('deleted_at' in patch && patch['deleted_at'] != null && concurrent) {
      if (Number(current['updated_at']) > Number(patch['deleted_at']))
        throw new Conflict(
          op.table,
          op.id,
          businessId,
          data,
          current,
          'deleted here, but edited later on another device',
        );
    }

    if (op.table === 'number_reservations') {
      // a device only reports use, and use only grows
      const used = Math.max(Number(current['used'] ?? 0), Number(data['used'] ?? 0));
      if (current['device_id'] && current['device_id'] !== caller.deviceId)
        throw new Rejected('that range belongs to another device');
      const size = Number(current['to_number']) - Number(current['from_number']) + 1;
      if (used > size) throw new Rejected('more numbers used than the range holds');
      await tx
        .update(t)
        .set({
          used,
          status: used >= size ? 'used' : current['status'],
          updated_at: Date.now(),
          version: sql`${t.version} + 1`,
        })
        .where(eq(t.id, op.id));
      continue;
    }

    if (!changed.length) continue;
    const nextVersion = concurrent
      ? Number(current['version']) + 1
      : (sentVersion ?? Number(current['version']) + 1);
    await tx
      .update(t)
      .set({
        ...patch,
        ...('version' in t ? { version: nextVersion } : {}),
        ...('updated_at' in t ? { updated_at: Number(data['updated_at'] ?? Date.now()) } : {}),
        ...('updated_by' in t ? { updated_by: caller.userId } : {}),
      })
      .where(eq(t.id, op.id));
  }

  // every document touched: the engine prices it again, and it must agree
  const renumbered: { id: string; from: string; to: string }[] = [];
  for (const id of touchedDocs) {
    if (!id || id === 'undefined') continue;
    const doc = d.schema.documents;
    const lines = d.schema.document_lines;
    const [row]: Row[] = await tx.select().from(doc).where(eq(doc.id, id)).limit(1);
    if (!row) throw new Rejected(`document ${id} is missing`);
    // a deleted document (a discarded draft, or a refused one stored deleted) needs no price or number
    if (row['deleted_at'] != null) continue;
    const ls: Row[] = await tx.select().from(lines).where(eq(lines.document_id, id));
    // the engine prices again every document issued or revised in this upload: that is when its money
    // becomes a tax record. A draft at rest, or a document arriving already issued (a business being
    // converted, history from an import or an earlier engine), must agree with itself: every head of tax
    // with its rate, the totals with the lines
    const live = ls.filter((l) => l['deleted_at'] == null);
    const errors =
      issuedNow.has(id) || revisedNow.has(id)
        ? recomputeErrors(row, live)
        : consistencyValidator(row, live);
    if (errors.length)
      throw new Rejected(
        `document ${row['number'] ?? id}: the totals do not match the lines (${errors.slice(0, 3).join('; ')})`,
      );

    // numbers: a provisional one, or one already taken by another document, gets the next real number
    if (row['status'] !== 'draft' && row['number']) {
      const clash = await tx
        .select({ id: doc.id })
        .from(doc)
        .where(
          and(
            eq(doc.business_id, row['business_id']),
            eq(doc.type, row['type']),
            eq(doc.number, row['number']),
            ne(doc.id, id),
          ),
        )
        .limit(1);
      if (isProvisional(String(row['number'])) || clash.length) {
        const from = String(row['number']);
        const c: Ctx = { ...ctx, businessId: String(row['business_id']), tx };
        if (clash.length)
          await tx
            .update(doc)
            .set({ number: `PROV-CLASH-${Date.now() % 1e8}` })
            .where(eq(doc.id, id));
        const fin = await new DocumentFlowRepo(d).finaliseNumberIn(tx, c, id);
        const to = String(fin['number']);
        await writeAudit(
          d,
          tx,
          c,
          'documents',
          id,
          'update',
          { number: from },
          {
            number: to,
            reason: issuedNow.has(id) ? 'number finalised on sync' : 'number replaced on sync',
          },
        );
        renumbered.push({ id, from, to });
      }
    }
  }
  const issued = [...issuedNow]
    .filter((id) => !!id)
    .map((id) => ({ id, businessId: issuedBiz.get(id) ?? '' }));
  return { renumbered, events: { issued, payments: paymentsNow } };
}

const roleName = (p: Permissions) => p.roleName ?? p.role;

/**
 * May this person make every change in the transaction (prompt 42)? Checked before anything is written, by
 * the shared matrix: documents by their kind and what happens to them (create, edit, issue, cancel),
 * payments likewise, other tables by their module. Rows that only follow from a document or payment
 * (ledger postings, its stock movements, allocations) pass with it. With the organisation's approval
 * policy on, a cancellation or a revision of an issued document by someone who cannot approve is held.
 */
async function authorise(d: PgDatabase, tx: any, caller: SyncCaller, ctxTx: ClientTx) {
  const p = caller.perms;
  if (!canWriteAnything(p)) throw new Rejected(`your role (${roleName(p)}) can only view`);
  const need = (m: Module, a: Parameters<typeof can>[2]) => {
    if (!can(p, m, a)) throw new Rejected(`your role (${roleName(p)}) cannot ${a} ${m}`);
  };
  const rowOf = async (table: string, id: string): Promise<Row | null> => {
    const t = d.schema[table as keyof typeof d.schema];
    const [r]: Row[] = await tx.select().from(t).where(eq(t.id, id)).limit(1);
    return r ?? null;
  };
  const docs = new Map<string, Row | null>();
  const docBefore = async (id: string) => {
    if (!docs.has(id)) docs.set(id, await rowOf('documents', id));
    return docs.get(id) ?? null;
  };
  const docKind = async (id: string): Promise<string | null> => {
    const sent = ctxTx.ops.find((o) => o.table === 'documents' && o.id === id)?.data?.['type'];
    if (typeof sent === 'string') return sent;
    const r = await docBefore(id);
    return r ? String(r['type']) : null;
  };
  let primary = false;
  const following: CrudOp[] = [];

  for (const op of ctxTx.ops) {
    const access = tableAccess(op.table);
    if (access.serverOnly) throw new Rejected(`${op.table} is kept by the server`);
    if (op.table === 'review_items') {
      // approval requests come from the server only: one made on a device could name anyone as the asker
      const kind =
        op.data?.['kind'] ??
        (op.op === 'PUT' ? undefined : (await rowOf('review_items', op.id))?.['kind']);
      const before = op.op === 'PUT' ? await rowOf('review_items', op.id) : null;
      if (kind === 'approval_request' || before?.['kind'] === 'approval_request')
        throw new Rejected('approval requests are kept by the server');
    }
    if (access.anyWriter) continue;
    const data = op.data ?? {};

    if (op.table === 'documents') {
      const before = await docBefore(op.id);
      const after = { ...(before ?? {}), ...data };
      const kind = String(after['type'] ?? '');
      if (before && data['type'] !== undefined && data['type'] !== before['type'])
        throw new Rejected('a document cannot change its kind');
      const m = documentModule(kind);
      const action = op.op === 'DELETE' ? 'edit' : changeAction(op.op, before, after);
      need(m, action);
      if (action === 'issue' && !before) need(m, 'create');
      if (!caller.approvedBy && before?.['status'] === 'issued') {
        const revising = Number(after['revision'] ?? 1) === Number(before['revision'] ?? 1) + 1;
        const change = action === 'cancel' ? 'cancel' : revising ? 'revise' : null;
        if (change && needsApproval(p, caller.policy, m, change))
          throw new NeedsApproval(
            m,
            change,
            op.id,
            String(before['business_id']),
            before,
            change === 'cancel'
              ? `cancelling ${String(before['number'])} waits for an approver`
              : `changing ${String(before['number'])} waits for an approver`,
          );
      }
      primary = true;
    } else if (op.table === 'document_lines') {
      const line = op.op === 'PUT' ? null : await rowOf('document_lines', op.id);
      const docId = String(data['document_id'] ?? line?.['document_id'] ?? '');
      const kind = docId ? await docKind(docId) : null;
      if (!kind) throw new Rejected('a line needs its document');
      const m = documentModule(kind);
      if (!can(p, m, 'create') && !can(p, m, 'edit'))
        throw new Rejected(`your role (${roleName(p)}) cannot change ${m}`);
      primary = true;
    } else if (op.table === 'payments') {
      const before = await rowOf('payments', op.id);
      const cancelling = data['status'] === 'cancelled' && before?.['status'] !== 'cancelled';
      const action = !before ? 'create' : cancelling ? 'cancel' : 'edit';
      need('payments', action);
      if (
        cancelling &&
        before &&
        !caller.approvedBy &&
        needsApproval(p, caller.policy, 'payments', 'cancel')
      )
        throw new NeedsApproval(
          'payments',
          'cancel',
          op.id,
          String(before['business_id']),
          before,
          'cancelling a payment waits for an approver',
        );
      primary = true;
    } else if (access.follows) {
      following.push(op);
    } else {
      const m = access.module as Module;
      const exists = op.op === 'PUT' ? !!(await rowOf(op.table, op.id)) : true;
      need(m, exists || !MODULE_ACTIONS[m].includes('create') ? 'edit' : 'create');
    }
  }
  for (const op of following) {
    const m = tableAccess(op.table).module as Module;
    if (!primary && !can(p, m, 'create') && !can(p, m, 'edit'))
      throw new Rejected(`your role (${roleName(p)}) cannot change ${op.table}`);
  }
}

/** Lines of a draft are free; lines of an issued document only change with its revision in the same upload. */
async function assertLineWritable(
  d: PgDatabase,
  tx: any,
  documentId: string,
  revised: Set<string>,
) {
  const doc = d.schema.documents;
  const [row]: Row[] = await tx
    .select({ status: doc.status })
    .from(doc)
    .where(eq(doc.id, documentId))
    .limit(1);
  if (!row) throw new Rejected(`the document of this line is missing (${documentId})`);
  // a document made in this same upload (a cancelled one arriving whole, during conversion) brings its lines
  if (row['status'] === 'cancelled' && !revised.has(documentId))
    throw new Rejected('lines of a cancelled document cannot change');
  if (row['status'] === 'issued' && !revised.has(documentId))
    throw new Rejected('lines of an issued document change only with a revision');
}

export async function raiseConflict(
  d: PgDatabase,
  ctx: Ctx,
  caller: SyncCaller,
  ctxTx: ClientTx,
  c: Conflict,
): Promise<string> {
  const c2: Ctx = { ...ctx, businessId: c.businessId, actor: 'system:sync' };
  const label =
    c.table === 'documents'
      ? String(c.theirs['number'] ?? c.theirs['party_name'] ?? 'draft')
      : `${c.table} ${c.rowId.slice(0, 8)}`;
  const strip = (r: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => !['org_id', 'business_id'].includes(k)));
  const item = await new ReviewRepo(d).create(c2, {
    kind: 'sync_conflict',
    status: 'pending',
    payload_json: { table: c.table, rowId: c.rowId, deviceId: caller.deviceId, txId: ctxTx.txId },
    suggestion_json: {
      table: c.table,
      rowId: c.rowId,
      label,
      reason: c.message,
      mine: strip(c.mine),
      theirs: strip(c.theirs),
      ops: ctxTx.ops,
      deviceId: caller.deviceId,
      byUser: caller.userId,
    },
    diff_json: null,
    source: 'sync',
    confidence: null,
    dedupe_key: `sync_conflict:${caller.deviceId}:${ctxTx.txId}`,
  });
  return String(item['id']);
}

/** For tests and the admin page: how many uploads a device has had applied, by outcome. */
async function raiseApproval(
  d: PgDatabase,
  ctx: Ctx,
  caller: SyncCaller,
  ctxTx: ClientTx,
  a: NeedsApproval,
): Promise<string> {
  const c2: Ctx = { ...ctx, businessId: a.businessId, actor: 'system:sync' };
  const strip = (r: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => !['org_id', 'business_id'].includes(k)));
  const label = String(a.theirs['number'] ?? a.theirs['reference'] ?? a.rowId.slice(0, 8));
  const item = await new ReviewRepo(d).create(c2, {
    kind: 'approval_request',
    status: 'pending',
    payload_json: { table: a.module === 'payments' ? 'payments' : 'documents', rowId: a.rowId },
    suggestion_json: {
      table: a.module === 'payments' ? 'payments' : 'documents',
      rowId: a.rowId,
      module: a.module,
      change: a.change,
      label,
      reason: a.message,
      theirs: strip(a.theirs),
      ops: ctxTx.ops,
      deviceId: caller.deviceId,
      txId: ctxTx.txId,
      byUser: caller.userId,
    },
    diff_json: null,
    source: 'sync',
    confidence: null,
    dedupe_key: `approval:${caller.deviceId}:${ctxTx.txId}`,
  });
  return String(item['id']);
}

export async function appliedCounts(
  d: PgDatabase,
  orgId: string,
  deviceId: string,
): Promise<Record<string, number>> {
  const rows = await d.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx`SELECT outcome, count(*)::int AS n FROM sync_applied WHERE device_id = ${deviceId} GROUP BY outcome`;
  });
  return Object.fromEntries(rows.map((r) => [String(r['outcome']), Number(r['n'])]));
}

export const _test = { coerce, newId };

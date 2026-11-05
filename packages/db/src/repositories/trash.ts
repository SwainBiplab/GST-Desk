/**
 * The trash: drafts, parties and items that were deleted stay for 30 days, can be brought back, and
 * are removed for good after that (or when someone chooses to). Issued documents never go in the
 * trash: they are cancelled, not deleted.
 */
import { isTrashExpired, trashDaysLeft, trashPurgeAt } from '@gst/domain';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import type { Database } from '../database';
import type { Row } from '../schema';

import { BaseRepo, NotFoundError, RuleError, runInTx, writeAudit, type Ctx } from './base';

export type TrashTable = 'parties' | 'items' | 'documents';
export const TRASH_TABLES: readonly TrashTable[] = ['parties', 'items', 'documents'];

export interface TrashEntry {
  table: TrashTable;
  id: string;
  /** The party type, the item kind or the document type. */
  type: string;
  name: string;
  /** For a draft document, who it was for. */
  partyName: string | null;
  deletedAt: number;
  purgeAt: number;
  daysLeft: number;
}

const n = (v: unknown): number => Number(v ?? 0);

/** An error's own message and the database's underneath it (drivers put the reason in `cause`). */
const causeText = (e: Error): string =>
  `${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ''}`;

export class TrashRepo {
  constructor(private readonly d: Database) {}

  /** Everything in the trash, most recently deleted first. */
  async list(ctx: Ctx, nowMs = Date.now()): Promise<TrashEntry[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const out: TrashEntry[] = [];
      const s = this.d.schema;
      const entry = (
        table: TrashTable,
        r: Row,
        name: string,
        type: string,
        partyName: string | null,
      ) => {
        const deletedAt = n(r['deleted_at']);
        out.push({
          table,
          id: String(r['id']),
          type,
          name,
          partyName,
          deletedAt,
          purgeAt: trashPurgeAt(deletedAt),
          daysLeft: trashDaysLeft(deletedAt, nowMs),
        });
      };
      for (const r of (await tx
        .select()
        .from(s.parties)
        .where(
          and(eq(s.parties.business_id, ctx.businessId), isNotNull(s.parties.deleted_at)),
        )) as Row[])
        entry('parties', r, String(r['name']), String(r['type'] ?? 'customer'), null);
      for (const r of (await tx
        .select()
        .from(s.items)
        .where(
          and(eq(s.items.business_id, ctx.businessId), isNotNull(s.items.deleted_at)),
        )) as Row[])
        entry('items', r, String(r['name']), String(r['kind'] ?? 'goods'), null);
      for (const r of (await tx
        .select()
        .from(s.documents)
        .where(
          and(
            eq(s.documents.business_id, ctx.businessId),
            isNotNull(s.documents.deleted_at),
            eq(s.documents.status, 'draft'),
          ),
        )) as Row[])
        entry(
          'documents',
          r,
          String(r['party_name'] ?? ''),
          String(r['type']),
          (r['party_name'] as string | null) ?? null,
        );
      return out.sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id));
    });
  }

  /** Bring something back. It returns as it was, unless it now clashes with something added since. */
  async restore(ctx: Ctx, table: TrashTable, id: string): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      if (!TRASH_TABLES.includes(table))
        throw new RuleError('That cannot be restored from the trash.');
      const c: Ctx = { ...ctx, tx };
      const repo = new BaseRepo(this.d, table);
      const tbl = this.d.schema[table];
      const [row]: Row[] = await tx
        .select()
        .from(tbl)
        .where(and(eq(tbl.id, id), eq(tbl.business_id, ctx.businessId)))
        .limit(1);
      if (!row || row['deleted_at'] == null) throw new NotFoundError(table, id);
      if (table === 'documents' && row['status'] !== 'draft')
        throw new RuleError('Only a draft can be restored from the trash.');
      try {
        return await repo.restore(c, id);
      } catch (e) {
        if (e instanceof Error && /unique|constraint/i.test(causeText(e)))
          throw new RuleError(
            'This clashes with something added since it was deleted (the same SKU, barcode or number). Change that first.',
          );
        throw e;
      }
    });
  }

  /** Remove one thing for good. Only what is in the trash, and only drafts among documents. */
  async purge(ctx: Ctx, table: TrashTable, id: string): Promise<void> {
    await runInTx(this.d, ctx, (tx) => this.purgeIn(tx, { ...ctx, tx }, table, id));
  }

  /** Remove for good everything that has been in the trash for 30 days. Returns how many. */
  async purgeExpired(ctx: Ctx, nowMs = Date.now()): Promise<number> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const expired = (await this.list(c, nowMs)).filter((e) => isTrashExpired(e.deletedAt, nowMs));
      for (const e of expired) await this.purgeIn(tx, c, e.table, e.id);
      return expired.length;
    });
  }

  /** Empty the trash. Returns how many things went. */
  async empty(ctx: Ctx): Promise<number> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const all = await this.list(c);
      for (const e of all) await this.purgeIn(tx, c, e.table, e.id);
      return all.length;
    });
  }

  private async purgeIn(tx: any, ctx: Ctx, table: TrashTable, id: string): Promise<void> {
    if (!TRASH_TABLES.includes(table)) throw new RuleError('That cannot be deleted for good.');
    const s = this.d.schema;
    const t = s[table];
    const [row]: Row[] = await tx
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.business_id, ctx.businessId)))
      .limit(1);
    if (!row) throw new NotFoundError(table, id);
    if (row['deleted_at'] == null)
      throw new RuleError('Only things in the trash can be deleted for good.');
    if (table === 'documents') {
      if (row['status'] !== 'draft') throw new RuleError('Only a draft can be deleted for good.');
      await tx.delete(s.document_lines).where(eq(s.document_lines.document_id, id));
    }
    try {
      await tx
        .delete(t)
        .where(and(eq(t.id, id), eq(t.business_id, ctx.businessId), isNotNull(t.deleted_at)));
    } catch (e) {
      if (e instanceof Error && /foreign key/i.test(causeText(e)))
        throw new RuleError(
          'This is still used by something else, so it cannot be deleted for good.',
        );
      throw e;
    }
    // the files attached to it are hidden too; their bytes are shared by content and are not touched here
    await tx
      .update(s.attachments)
      .set({ deleted_at: Date.now() })
      .where(
        and(
          eq(s.attachments.business_id, ctx.businessId),
          eq(s.attachments.owner_table, table),
          eq(s.attachments.owner_id, id),
          sql`${s.attachments.deleted_at} IS NULL`,
        ),
      );
    await writeAudit(this.d, tx, ctx, table, id, 'purge', row, null);
  }
}

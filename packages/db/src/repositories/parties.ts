import {
  balanceOf,
  buildAgeing,
  buildStatement,
  openingBalanceChange,
  type AccountDoc,
  type AccountPayment,
  type Ageing,
  type AccountKey,
  type PartyAccountInput,
  type Statement,
} from '@gst/domain';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { NewRow, Row } from '../schema';

import {
  BaseRepo,
  ImportCancelled,
  NotFoundError,
  RuleError,
  ftsIds,
  runInTx,
  type Ctx,
} from './base';

/** Ledger account codes for the keys the domain posting rules use. */
const ACCOUNT_CODE: Partial<Record<AccountKey, string>> = {
  receivables: '1200',
  payables: '2000',
  openingEquity: '3100',
};

export interface PartyLite {
  id: string;
  name: string;
  gstin: string | null;
  phone: string | null;
}

/** What `merge` did, with enough to undo it. */
export interface MergeRecord {
  sourceId: string;
  targetId: string;
  /** Rows re-pointed from source to target, by table. */
  moved: Record<'documents' | 'payments' | 'reminders' | 'ledger_entries', string[]>;
  sourceBefore: Row;
  targetBefore: Row;
}

const MOVED_TABLES = ['documents', 'payments', 'reminders', 'ledger_entries'] as const;
const FILL_FIELDS = [
  'gstin',
  'pan',
  'phone',
  'email',
  'city',
  'state_code',
  'trade_name',
  'opening_balance_date',
] as const;

const today = () => new Date().toISOString().slice(0, 10);

/** Customers and suppliers: search, opening-balance postings, merge and undo. */
export class PartyRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'parties');
  }

  async findByGstin(ctx: Ctx, gstin: string): Promise<Row[]> {
    return this.list(ctx, { where: eq(this.t.gstin, gstin.toUpperCase()) });
  }

  /** Full-text search over name, trade name, GSTIN, phone, email and city. */
  async search(ctx: Ctx, q: string, limit = 20): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) =>
      this.byIds(tx, ctx, await ftsIds(this.d, tx, ctx, 'parties', q, limit)),
    );
  }

  /** Just what duplicate detection needs, for every live party. */
  async listLite(ctx: Ctx): Promise<PartyLite[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.t;
      const rows: Row[] = await tx
        .select({ id: t.id, name: t.name, gstin: t.gstin, phone: t.phone })
        .from(t)
        .where(and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at)));
      return rows.map((r) => ({
        id: r['id'],
        name: r['name'],
        gstin: r['gstin'],
        phone: r['phone'],
      }));
    });
  }

  /** Create a party; a non-zero opening balance posts balanced ledger entries in the same transaction. */
  override async create(ctx: Ctx, values: NewRow & { id?: string }): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const party = await this.createIn(tx, ctx, values);
      await this.postOpening(tx, ctx, party, 0, Number(party['opening_balance_paise'] ?? 0));
      return party;
    });
  }

  /**
   * Create many parties in one transaction: all are stored or none. Opening balances post their
   * ledger entries like `create`. Stops cleanly, writing nothing, if `shouldCancel` returns true.
   */
  async bulkCreate(
    ctx: Ctx,
    rows: NewRow[],
    opts: {
      onProgress?: (done: number, total: number) => void | Promise<void>;
      shouldCancel?: () => boolean;
    } = {},
  ): Promise<{ created: number }> {
    return runInTx(this.d, ctx, async (tx) => {
      let done = 0;
      for (const values of rows) {
        if (opts.shouldCancel?.()) throw new ImportCancelled();
        const party = await this.createIn(tx, ctx, values);
        await this.postOpening(tx, ctx, party, 0, Number(party['opening_balance_paise'] ?? 0));
        done++;
        if (done % 50 === 0 || done === rows.length) await opts.onProgress?.(done, rows.length);
      }
      return { created: done };
    });
  }

  /** Update a party; a changed opening balance posts the difference. */
  override async update(
    ctx: Ctx,
    id: string,
    patch: NewRow,
    expectedVersion: number,
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const before = await this.getIn(tx, ctx, id);
      const after = await this.updateIn(tx, ctx, id, patch, expectedVersion);
      if (before && 'opening_balance_paise' in patch) {
        await this.postOpening(
          tx,
          ctx,
          after,
          Number(before['opening_balance_paise'] ?? 0),
          Number(after['opening_balance_paise'] ?? 0),
        );
      }
      return after;
    });
  }

  private async accountId(tx: any, ctx: Ctx, key: AccountKey): Promise<string> {
    const code = ACCOUNT_CODE[key];
    const t = this.d.schema.ledger_accounts;
    const [row] = code
      ? await tx
          .select({ id: t.id })
          .from(t)
          .where(and(eq(t.business_id, ctx.businessId), eq(t.code, code), isNull(t.deleted_at)))
          .limit(1)
      : [];
    if (!row) throw new RuleError(`ledger account for ${key} is missing`);
    return row.id;
  }

  /** Ledger entries for a change of a party's opening balance from `oldPaise` to `newPaise`. */
  private async postOpening(
    tx: any,
    ctx: Ctx,
    party: Row,
    oldPaise: number,
    newPaise: number,
  ): Promise<void> {
    const lines = openingBalanceChange(BigInt(oldPaise), BigInt(newPaise), party['name']);
    const ledger = new BaseRepo(this.d, 'ledger_entries');
    for (const l of lines) {
      await ledger.create(
        { ...ctx, tx },
        {
          party_id: party['id'],
          account_id: await this.accountId(tx, ctx, l.account),
          debit_paise: Number(l.debitPaise),
          credit_paise: Number(l.creditPaise),
          date: party['opening_balance_date'] ?? today(),
          narration: l.narration,
        },
      );
    }
  }

  protected override async beforeSoftDelete(ctx: Ctx, tx: any, row: Row) {
    for (const [table, col] of [
      ['documents', 'party_id'],
      ['payments', 'party_id'],
    ] as const) {
      if (await this.isReferenced(tx, ctx, table, col, row['id'])) {
        throw new RuleError(`party ${row['id']} is referenced by ${table} and cannot be deleted`);
      }
    }
  }

  /**
   * Fold `source` into `target`: documents, payments, reminders and ledger entries move over, empty fields
   * on the target are filled from the source, opening balances add up, and the source is archived.
   * One transaction; every change is audited. Pass the result to `undoMerge` to reverse it.
   */
  async merge(ctx: Ctx, sourceId: string, targetId: string): Promise<MergeRecord> {
    if (sourceId === targetId) throw new RuleError('cannot merge a party into itself');
    return runInTx(this.d, ctx, async (tx) => {
      const c = { ...ctx, tx };
      const source = await this.getIn(tx, ctx, sourceId);
      const target = await this.getIn(tx, ctx, targetId);
      if (!source) throw new NotFoundError('parties', sourceId);
      if (!target) throw new NotFoundError('parties', targetId);

      const moved = await this.repoint(c, sourceId, targetId);

      // fill gaps on the target, union tags and contact lists
      const fill: NewRow = {};
      for (const f of FILL_FIELDS) if (!target[f] && source[f]) fill[f] = source[f];
      const tags = [...new Set([...(target['tags_json'] ?? []), ...(source['tags_json'] ?? [])])];
      if (tags.length > (target['tags_json'] ?? []).length) fill['tags_json'] = tags;
      for (const f of ['addresses_json', 'contacts_json'] as const) {
        const merged = dedupe([...(target[f] ?? []), ...(source[f] ?? [])]);
        if (merged.length > (target[f] ?? []).length) fill[f] = merged;
      }
      if (source['notes'])
        fill['notes'] = target['notes']
          ? `${target['notes']}\n${source['notes']}`
          : source['notes'];
      fill['credit_days'] = Math.max(target['credit_days'] ?? 0, source['credit_days'] ?? 0);
      fill['credit_limit_paise'] = Math.max(
        target['credit_limit_paise'] ?? 0,
        source['credit_limit_paise'] ?? 0,
      );

      // opening balances move across: zero the source, add to the target (each posts its own ledger entries)
      const sourceOpening = Number(source['opening_balance_paise'] ?? 0);
      if (sourceOpening !== 0) {
        fill['opening_balance_paise'] =
          Number(target['opening_balance_paise'] ?? 0) + sourceOpening;
        await this.update(c, sourceId, { opening_balance_paise: 0 }, source['version']);
      }
      await this.update(c, targetId, fill, target['version']);
      const sourceNow = (await this.getIn(tx, ctx, sourceId))!;
      await this.softDelete(c, sourceId, sourceNow['version']);
      return { sourceId, targetId, moved, sourceBefore: source, targetBefore: target };
    });
  }

  /** Point every row of `from` at `to`. Returns the ids that moved, by table. */
  private async repoint(c: Ctx, from: string, to: string): Promise<MergeRecord['moved']> {
    const out = {
      documents: [],
      payments: [],
      reminders: [],
      ledger_entries: [],
    } as MergeRecord['moved'];
    for (const table of MOVED_TABLES) {
      const repo = new BaseRepo(this.d, table);
      const t = this.d.schema[table];
      const rows: Row[] = await c.tx
        .select({ id: t.id, version: t.version })
        .from(t)
        .where(and(eq(t.business_id, c.businessId), eq(t.party_id, from), isNull(t.deleted_at)));
      for (const r of rows) {
        await repo.update(c, r['id'], { party_id: to }, r['version']);
        out[table].push(r['id']);
      }
    }
    return out;
  }

  /**
   * Reverse a merge: restore the source party, move back the rows that are still on the target, and put
   * both parties' fields and opening balances back as they were.
   */
  async undoMerge(ctx: Ctx, rec: MergeRecord): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const c = { ...ctx, tx };
      const target = await this.getIn(tx, ctx, rec.targetId);
      if (!target) throw new NotFoundError('parties', rec.targetId);
      const source = await this.getIn(tx, ctx, rec.sourceId, true);
      if (!source?.['deleted_at'])
        throw new RuleError(
          'the merged party is no longer archived, so the merge cannot be undone',
        );
      await this.restore(c, rec.sourceId);

      for (const table of MOVED_TABLES) {
        const repo = new BaseRepo(this.d, table);
        const t = this.d.schema[table];
        for (const id of rec.moved[table]) {
          const [r] = await tx
            .select({ version: t.version, party_id: t.party_id })
            .from(t)
            .where(and(eq(t.id, id), eq(t.business_id, ctx.businessId), isNull(t.deleted_at)));
          if (r && r.party_id === rec.targetId)
            await repo.update(c, id, { party_id: rec.sourceId }, r.version);
        }
      }

      const restoreFields = (before: Row): NewRow =>
        Object.fromEntries(
          [
            ...FILL_FIELDS,
            'addresses_json',
            'contacts_json',
            'tags_json',
            'notes',
            'credit_days',
            'credit_limit_paise',
            'opening_balance_paise',
          ].map((f) => [f, before[f] ?? null]),
        );
      const t1 = (await this.getIn(tx, ctx, rec.targetId))!;
      await this.update(c, rec.targetId, restoreFields(rec.targetBefore), t1['version']);
      const s1 = (await this.getIn(tx, ctx, rec.sourceId))!;
      await this.update(c, rec.sourceId, restoreFields(rec.sourceBefore), s1['version']);
    });
  }
}

/* ------------------------------------------------------------------ accounts (statement, balance, ageing) */

export interface PartyAccount {
  partyId: string;
  /** Positive = they owe us; negative = we owe them. */
  balancePaise: bigint;
  overduePaise: bigint;
  ageing: Ageing;
  lastPaymentDate: string | null;
  documentCount: number;
}

const big = (v: unknown) => BigInt(Math.trunc(Number(v ?? 0)));

/** Issued documents and cleared payments of one party (or all), grouped by party. */
async function loadAccounts(
  d: Database,
  ctx: Ctx,
  tx: any,
  partyId?: string,
): Promise<Map<string, PartyAccountInput>> {
  const b = ctx.businessId;
  const only = partyId ? sql`AND party_id = ${partyId}` : sql``;
  const parties = await queryRows(
    d,
    tx,
    partyId
      ? sql`SELECT id, opening_balance_paise, opening_balance_date FROM parties WHERE business_id = ${b} AND deleted_at IS NULL AND id = ${partyId}`
      : sql`SELECT id, opening_balance_paise, opening_balance_date FROM parties WHERE business_id = ${b} AND deleted_at IS NULL`,
  );
  const docs = await queryRows(
    d,
    tx,
    sql`SELECT id, party_id, number, type, date, due_date, total_paise FROM documents
        WHERE business_id = ${b} AND deleted_at IS NULL AND status = 'issued' AND party_id IS NOT NULL ${only}`,
  );
  const pays = await queryRows(
    d,
    tx,
    sql`SELECT id, party_id, date, direction, amount_paise, mode, reference FROM payments
        WHERE business_id = ${b} AND deleted_at IS NULL AND status = 'cleared' AND party_id IS NOT NULL ${only}`,
  );

  const map = new Map<string, PartyAccountInput>();
  for (const p of parties) {
    map.set(String(p['id']), {
      openingPaise: big(p['opening_balance_paise']),
      openingDate: (p['opening_balance_date'] as string | null) ?? null,
      docs: [],
      payments: [],
    });
  }
  for (const r of docs) {
    map.get(String(r['party_id']))?.docs.push({
      id: String(r['id']),
      number: (r['number'] as string | null) ?? null,
      type: r['type'] as AccountDoc['type'],
      date: String(r['date']),
      dueDate: (r['due_date'] as string | null) ?? null,
      totalPaise: big(r['total_paise']),
    });
  }
  for (const r of pays) {
    map.get(String(r['party_id']))?.payments.push({
      id: String(r['id']),
      date: String(r['date']),
      direction: r['direction'] as AccountPayment['direction'],
      amountPaise: big(r['amount_paise']),
      mode: String(r['mode']),
      reference: (r['reference'] as string | null) ?? null,
    });
  }
  return map;
}

function summarise(partyId: string, a: PartyAccountInput, today: string): PartyAccount {
  const ageing = buildAgeing(a, today);
  const last =
    a.payments
      .filter((p) => p.direction === 'received')
      .map((p) => p.date)
      .sort()
      .pop() ?? null;
  return {
    partyId,
    balancePaise: balanceOf(a),
    overduePaise: ageing.direction === 'receivable' ? ageing.overduePaise : 0n,
    ageing,
    lastPaymentDate: last,
    documentCount: a.docs.length,
  };
}

/** Balance, overdue and ageing for every live party, from three queries. `todayIso` is the caller's date. */
export async function getPartyAccounts(
  d: Database,
  ctx: Ctx,
  todayIso: string,
): Promise<Map<string, PartyAccount>> {
  return runInTx(d, ctx, async (tx) => {
    const all = await loadAccounts(d, ctx, tx);
    return new Map([...all].map(([id, a]) => [id, summarise(id, a, todayIso)]));
  });
}

export interface PartyAccountDetail extends PartyAccount {
  input: PartyAccountInput;
  /** Amount of each issued document still unpaid by explicit allocations. */
  documentDue: Map<string, bigint>;
}

/** Everything the Party 360 page needs about one party's money. */
export async function getPartyAccount(
  d: Database,
  ctx: Ctx,
  partyId: string,
  todayIso: string,
): Promise<PartyAccountDetail> {
  return runInTx(d, ctx, async (tx) => {
    const input = (await loadAccounts(d, ctx, tx, partyId)).get(partyId);
    if (!input) throw new NotFoundError('parties', partyId);
    const alloc = await queryRows(
      d,
      tx,
      sql`SELECT a.document_id AS id, coalesce(sum(a.amount_paise), 0) AS paid
          FROM payment_allocations a JOIN documents dc ON dc.id = a.document_id
          WHERE a.business_id = ${ctx.businessId} AND a.deleted_at IS NULL AND dc.party_id = ${partyId}
          GROUP BY a.document_id`,
    );
    const paid = new Map(alloc.map((r) => [String(r['id']), big(r['paid'])]));
    const due = new Map(input.docs.map((x) => [x.id, x.totalPaise - (paid.get(x.id) ?? 0n)]));
    return { ...summarise(partyId, input, todayIso), input, documentDue: due };
  });
}

/** The statement for a date range (inclusive). Same engine as the balance, so they always agree. */
export async function getPartyStatement(
  d: Database,
  ctx: Ctx,
  partyId: string,
  range: { from?: string; to?: string } = {},
): Promise<Statement> {
  return runInTx(d, ctx, async (tx) => {
    const input = (await loadAccounts(d, ctx, tx, partyId)).get(partyId);
    if (!input) throw new NotFoundError('parties', partyId);
    return buildStatement(input, range);
  });
}

/** Payment and reminder history helpers. */
export class ReminderRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'reminders');
  }

  forParty(ctx: Ctx, partyId: string): Promise<Row[]> {
    return this.list(ctx, {
      where: eq(this.t.party_id, partyId),
      orderBy: sql`${this.t.sent_at} DESC`,
    });
  }
}

function dedupe<T>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

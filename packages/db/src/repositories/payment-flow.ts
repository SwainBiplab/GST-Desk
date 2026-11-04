/**
 * Money in and out (FR-050 to FR-053): record a payment or receipt against documents, carry any
 * remainder as party credit, apply credit to a later document, edit and delete payments, and read
 * what every document and party owes. Money is never computed here: the domain decides the
 * allocation, status, TCS and postings (`@gst/domain/payments`, `ledger`), this stores them.
 *
 * A document's balance is derived from its allocations every time (never stored), so it cannot drift:
 * `total − paid − credit applied − written off`. Only allocations of cleared payments count.
 */
import {
  balanceOfDocument,
  fyOf,
  overdueDays,
  payStatus,
  planCreditApplication,
  postPayment,
  postWriteOff,
  tcsOnReceipt,
  validateAllocations,
  type AllocationRequest,
  type CreditSource,
  type LedgerLine,
  type PayStatus,
} from '@gst/domain';
import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../database';
import type { NewRow, Row } from '../schema';

import { BusinessRepo } from './aggregates';
import { BaseRepo, NotFoundError, RuleError, runInTx, type Ctx } from './base';
import { DocumentFlowRepo, serialised } from './document-flow';
import { PeriodLockRepo, type LockOverride } from './period-lock';

export type Direction = 'received' | 'made';
export type PayMode = 'cash' | 'upi' | 'card' | 'bank' | 'cheque' | 'other' | 'adjustment';

/** Documents a payment of each direction can settle. */
const PAYABLE: Record<Direction, ReadonlySet<string>> = {
  received: new Set(['tax_invoice', 'bill_of_supply', 'debit_note']),
  made: new Set(['purchase_bill', 'expense']),
};
/** Documents that are credit in the party's favour once issued, usable against the other side's bills. */
const CREDIT_DOCS: Record<Direction, ReadonlySet<string>> = {
  received: new Set(['credit_note']),
  made: new Set(['purchase_return']),
};

const big = (v: unknown): bigint => BigInt(Math.trunc(Number(v ?? 0)));
const num = (v: bigint): number => Number(v);

export const directionOfDoc = (type: string): Direction | null =>
  PAYABLE.received.has(type) ? 'received' : PAYABLE.made.has(type) ? 'made' : null;

export interface PaymentInput {
  direction: Direction;
  partyId: string;
  date: string;
  mode: PayMode;
  /** Everything received or paid, including any TCS. */
  amountPaise: bigint;
  tcsPaise?: bigint;
  accountId?: string | null;
  /** Cheque number, or a UPI / bank reference. */
  reference?: string | null;
  chequeDate?: string | null;
  notes?: string | null;
  allocations: AllocationRequest[];
}

export interface PaymentResult {
  payment: Row;
  allocations: Row[];
  /** The receipt voucher made for a receipt (none for a payment made). */
  voucher: Row | null;
  /** Money left over after allocations: party credit. */
  remainderPaise: bigint;
}

export interface DocPosition {
  id: string;
  type: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  partyId: string | null;
  totalPaise: bigint;
  paidPaise: bigint;
  creditAppliedPaise: bigint;
  writtenOffPaise: bigint;
  /** Owed, or (for a credit document) the credit still unused. */
  balancePaise: bigint;
  status: PayStatus;
  overdueDays: number;
}

export interface PartyPosition {
  openingPaise: bigint;
  /** Σ balances of payable documents, both sides, signed: positive = they owe us. */
  documentsPaise: bigint;
  /** Unused credit in the party's favour (advances and credit documents), as a positive amount. */
  creditPaise: bigint;
  /** What Party 360 shows: opening + documents − credit. */
  outstandingPaise: bigint;
}

export class CreditAppliedError extends RuleError {
  override name = 'CreditAppliedError';
  constructor(
    message: string,
    readonly documents: { id: string; number: string | null; amountPaise: number }[],
  ) {
    super(message);
  }
}

export interface PaymentFilters {
  partyId?: string;
  direction?: Direction;
  mode?: PayMode;
  from?: string;
  to?: string;
  /** Matches the party name, reference or voucher number. */
  q?: string;
  limit?: number;
}

export interface PaymentListRow {
  id: string;
  date: string;
  direction: Direction;
  mode: string;
  partyId: string | null;
  partyName: string;
  amountPaise: bigint;
  tcsPaise: bigint;
  allocatedPaise: bigint;
  /** Left as party credit. */
  unallocatedPaise: bigint;
  reference: string | null;
  voucherId: string | null;
  voucherNumber: string | null;
  version: number;
}

export class PaymentFlowRepo extends BaseRepo {
  private readonly allocations: BaseRepo;
  private readonly ledger: BaseRepo;
  private readonly flow: DocumentFlowRepo;
  private readonly lock: PeriodLockRepo;

  constructor(d: Database) {
    super(d, 'payments');
    this.allocations = new BaseRepo(d, 'payment_allocations');
    this.ledger = new BaseRepo(d, 'ledger_entries');
    this.flow = new DocumentFlowRepo(d);
    this.lock = new PeriodLockRepo(d);
  }

  /* ------------------------------------------------------------------ what is owed */

  /**
   * Every issued document of a party (or all) that money settles, with its balance and derived status,
   * and the credit documents with how much of each is still unused. `today` is the caller's date.
   */
  async positionsIn(
    tx: any,
    ctx: Ctx,
    today: string,
    partyId?: string,
  ): Promise<{ documents: DocPosition[]; credits: DocPosition[] }> {
    const docs = this.d.schema.documents;
    const docRows: Row[] = await tx
      .select()
      .from(docs)
      .where(
        and(
          eq(docs.business_id, ctx.businessId),
          eq(docs.status, 'issued'),
          isNull(docs.deleted_at),
          ...(partyId ? [eq(docs.party_id, partyId)] : []),
        ),
      );
    const relevant = docRows.filter((r) => {
      const t = String(r['type']);
      return (
        PAYABLE.received.has(t) ||
        PAYABLE.made.has(t) ||
        CREDIT_DOCS.received.has(t) ||
        CREDIT_DOCS.made.has(t)
      );
    });

    const pay = this.d.schema.payments;
    const payRows: Row[] = await tx
      .select({ id: pay.id, status: pay.status })
      .from(pay)
      .where(and(eq(pay.business_id, ctx.businessId), isNull(pay.deleted_at)));
    const cleared = new Set(payRows.filter((p) => p['status'] === 'cleared').map((p) => p['id']));

    const al = this.d.schema.payment_allocations;
    const allocRows: Row[] = await tx
      .select()
      .from(al)
      .where(and(eq(al.business_id, ctx.businessId), isNull(al.deleted_at)));

    const paid = new Map<string, bigint>();
    const credit = new Map<string, bigint>();
    const written = new Map<string, bigint>();
    const usedAsSource = new Map<string, bigint>();
    const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
    for (const a of allocRows) {
      // an allocation of a payment that has not cleared (bounced, cancelled) settles nothing
      if (a['payment_id'] && !cleared.has(a['payment_id'])) continue;
      const amount = big(a['amount_paise']);
      const target = String(a['document_id']);
      if (a['kind'] === 'payment') add(paid, target, amount);
      else if (a['kind'] === 'credit_applied') {
        add(credit, target, amount);
        if (a['source_document_id']) add(usedAsSource, String(a['source_document_id']), amount);
      } else if (a['kind'] === 'write_off') add(written, target, amount);
    }

    const documents: DocPosition[] = [];
    const credits: DocPosition[] = [];
    for (const r of relevant) {
      const id = String(r['id']);
      const type = String(r['type']);
      const total = big(r['total_paise']);
      const isCredit = CREDIT_DOCS.received.has(type) || CREDIT_DOCS.made.has(type);
      const s = {
        totalPaise: total,
        paidPaise: isCredit ? 0n : (paid.get(id) ?? 0n),
        creditAppliedPaise: isCredit ? (usedAsSource.get(id) ?? 0n) : (credit.get(id) ?? 0n),
        writtenOffPaise: isCredit ? 0n : (written.get(id) ?? 0n),
      };
      const balance = balanceOfDocument(s);
      const row: DocPosition = {
        id,
        type,
        number: (r['number'] as string | null) ?? null,
        date: String(r['date']),
        dueDate: (r['due_date'] as string | null) ?? null,
        partyId: (r['party_id'] as string | null) ?? null,
        totalPaise: total,
        paidPaise: s.paidPaise,
        creditAppliedPaise: s.creditAppliedPaise,
        writtenOffPaise: s.writtenOffPaise,
        balancePaise: balance,
        status: payStatus(s),
        overdueDays: isCredit
          ? 0
          : overdueDays((r['due_date'] as string | null) ?? null, today, balance),
      };
      (isCredit ? credits : documents).push(row);
    }
    return { documents, credits };
  }

  async positions(ctx: Ctx, today: string, partyId?: string) {
    return runInTx(this.d, ctx, (tx) => this.positionsIn(tx, ctx, today, partyId));
  }

  /** Open documents the next payment of this direction can settle, oldest first (balance above zero). */
  async openDocuments(
    ctx: Ctx,
    partyId: string,
    direction: Direction,
    today: string,
  ): Promise<DocPosition[]> {
    const { documents } = await this.positions(ctx, today, partyId);
    return documents
      .filter((x) => PAYABLE[direction].has(x.type) && x.balancePaise > 0n)
      .sort(
        (a, b) =>
          (a.dueDate ?? a.date).localeCompare(b.dueDate ?? b.date) ||
          a.date.localeCompare(b.date) ||
          (a.number ?? '').localeCompare(b.number ?? '', 'en', { numeric: true }),
      );
  }

  /** Advance payments and credit documents of a party that can still be applied. */
  async creditSources(
    ctx: Ctx,
    partyId: string,
    direction: Direction,
    today: string,
  ): Promise<CreditSource[]> {
    return runInTx(this.d, ctx, async (tx) =>
      this.creditSourcesIn(tx, ctx, partyId, direction, today),
    );
  }

  async creditSourcesIn(
    tx: any,
    ctx: Ctx,
    partyId: string,
    direction: Direction,
    today: string,
  ): Promise<CreditSource[]> {
    const out: CreditSource[] = [];
    const { credits } = await this.positionsIn(tx, ctx, today, partyId);
    for (const c of credits) {
      if (!CREDIT_DOCS[direction].has(c.type) || c.balancePaise <= 0n) continue;
      out.push({
        kind: 'document',
        id: c.id,
        date: c.date,
        label: c.number ?? c.type,
        remainingPaise: c.balancePaise,
      });
    }
    const pay = this.d.schema.payments;
    const payRows: Row[] = await tx
      .select()
      .from(pay)
      .where(
        and(
          eq(pay.business_id, ctx.businessId),
          eq(pay.party_id, partyId),
          eq(pay.direction, direction),
          eq(pay.status, 'cleared'),
          isNull(pay.deleted_at),
        ),
      );
    const al = this.d.schema.payment_allocations;
    const allocs: Row[] = await tx
      .select()
      .from(al)
      .where(and(eq(al.business_id, ctx.businessId), isNull(al.deleted_at)));
    const docs = this.d.schema.documents;
    for (const p of payRows) {
      const used = allocs
        .filter((a) => a['payment_id'] === p['id'] && a['kind'] !== 'write_off')
        .reduce((n, a) => n + big(a['amount_paise']), 0n);
      const remaining = big(p['amount_paise']) - big(p['tcs_paise']) - used;
      if (remaining <= 0n) continue;
      let label = `${p['date']}`;
      if (p['voucher_id']) {
        const [v]: Row[] = await tx
          .select({ number: docs.number })
          .from(docs)
          .where(eq(docs.id, p['voucher_id']))
          .limit(1);
        if (v?.['number']) label = v['number'];
      }
      out.push({
        kind: 'payment',
        id: p['id'],
        date: String(p['date']),
        label,
        remainingPaise: remaining,
      });
    }
    return out;
  }

  /** Opening balance, document balances and credit for one party: the three figures that must agree. */
  async partyPosition(ctx: Ctx, partyId: string, today: string): Promise<PartyPosition> {
    return runInTx(this.d, ctx, async (tx) => {
      const par = this.d.schema.parties;
      const [p]: Row[] = await tx
        .select({ opening: par.opening_balance_paise })
        .from(par)
        .where(and(eq(par.id, partyId), eq(par.business_id, ctx.businessId)))
        .limit(1);
      if (!p) throw new NotFoundError('parties', partyId);
      const { documents } = await this.positionsIn(tx, ctx, today, partyId);
      let docs = 0n;
      for (const d of documents) {
        const side = directionOfDoc(d.type)!;
        docs += side === 'received' ? d.balancePaise : -d.balancePaise;
      }
      let credit = 0n;
      for (const dir of ['received', 'made'] as const) {
        for (const c of await this.creditSourcesIn(tx, ctx, partyId, dir, today))
          credit += dir === 'received' ? c.remainingPaise : -c.remainingPaise;
      }
      const opening = big(p['opening']);
      return {
        openingPaise: opening,
        documentsPaise: docs,
        creditPaise: credit,
        outstandingPaise: opening + docs - credit,
      };
    });
  }

  /* ------------------------------------------------------------------ TCS */

  /** TCS u/s 206C(1H) on a receipt of `considerationPaise` from this party on `date`. */
  async tcsFor(
    ctx: Ctx,
    partyId: string,
    date: string,
    considerationPaise: bigint,
    rateBp = 10,
    excludePaymentId?: string,
  ): Promise<{ tcsPaise: bigint; note: string }> {
    return runInTx(this.d, ctx, async (tx) => {
      const business = await new BusinessRepo(this.d).get({ ...ctx, tx });
      const fy = fyOf(date, Number(business?.['fy_start_month'] ?? 4));
      const pay = this.d.schema.payments;
      const rows: Row[] = await tx
        .select()
        .from(pay)
        .where(
          and(
            eq(pay.business_id, ctx.businessId),
            eq(pay.party_id, partyId),
            eq(pay.direction, 'received'),
            eq(pay.status, 'cleared'),
            isNull(pay.deleted_at),
          ),
        );
      let before = 0n;
      for (const r of rows) {
        if (r['id'] === excludePaymentId) continue;
        const d = String(r['date']);
        if (d >= fy.start && d <= fy.end && d <= date)
          before += big(r['amount_paise']) - big(r['tcs_paise']);
      }
      return tcsOnReceipt({
        considerationPaise,
        cumulativeBeforePaise: before,
        rateBp,
        date,
      });
    });
  }

  /* ------------------------------------------------------------------ ledger helpers */

  private async postLinesIn(tx: any, ctx: Ctx, payment: Row, lines: LedgerLine[]): Promise<void> {
    for (const l of lines) {
      await (this.ledger as any).createIn(tx, ctx, {
        payment_id: payment['id'],
        party_id:
          l.account === 'receivables' || l.account === 'payables' ? payment['party_id'] : null,
        account_id: await this.flow.accountIdIn(tx, ctx, l.account),
        debit_paise: num(l.debitPaise),
        credit_paise: num(l.creditPaise),
        date: payment['date'],
        narration: l.narration,
      });
    }
  }

  /** Zero what a payment has posted: one contra entry per account and party for the net still there. */
  private async reverseLedgerIn(tx: any, ctx: Ctx, payment: Row, narration: string): Promise<void> {
    const t = this.d.schema.ledger_entries;
    const rows: Row[] = await tx
      .select()
      .from(t)
      .where(
        and(
          eq(t.business_id, ctx.businessId),
          eq(t.payment_id, payment['id']),
          isNull(t.deleted_at),
        ),
      );
    const net = new Map<string, { account: string; party: string | null; net: number }>();
    for (const r of rows) {
      const key = `${r['account_id']}|${r['party_id'] ?? ''}`;
      const cur = net.get(key) ?? {
        account: r['account_id'],
        party: (r['party_id'] as string | null) ?? null,
        net: 0,
      };
      cur.net += Number(r['debit_paise']) - Number(r['credit_paise']);
      net.set(key, cur);
    }
    for (const n of net.values()) {
      if (n.net === 0) continue;
      await (this.ledger as any).createIn(tx, ctx, {
        payment_id: payment['id'],
        party_id: n.party,
        account_id: n.account,
        debit_paise: n.net < 0 ? -n.net : 0,
        credit_paise: n.net > 0 ? n.net : 0,
        date: payment['date'],
        narration,
      });
    }
  }

  private postingsIn(input: PaymentInput, wo: bigint): LedgerLine[] {
    const lines = postPayment({
      direction: input.direction,
      mode: input.mode,
      amountPaise: input.amountPaise,
      ...(input.tcsPaise ? { tcsPaise: input.tcsPaise } : {}),
    });
    if (wo > 0n) lines.push(...postWriteOff(input.direction, wo));
    return lines;
  }

  /* ------------------------------------------------------------------ record */

  private checkInputIn(input: PaymentInput): void {
    if (input.amountPaise <= 0n) throw new RuleError('The amount must be more than zero.');
    if ((input.tcsPaise ?? 0n) < 0n) throw new RuleError('TCS cannot be negative.');
    if (input.mode === 'cheque') {
      if (!input.reference?.trim()) throw new RuleError('A cheque needs its number.');
      if (!input.chequeDate) throw new RuleError('A cheque needs its date.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new RuleError('The date is not valid.');
  }

  private async writeAllocationsIn(
    tx: any,
    ctx: Ctx,
    payment: Row,
    requests: readonly AllocationRequest[],
  ): Promise<Row[]> {
    const out: Row[] = [];
    for (const a of requests) {
      if (a.amountPaise > 0n)
        out.push(
          await (this.allocations as any).createIn(tx, ctx, {
            payment_id: payment['id'],
            document_id: a.documentId,
            amount_paise: num(a.amountPaise),
            kind: 'payment',
          }),
        );
      if ((a.writeOffPaise ?? 0n) > 0n)
        out.push(
          await (this.allocations as any).createIn(tx, ctx, {
            payment_id: payment['id'],
            document_id: a.documentId,
            amount_paise: num(a.writeOffPaise!),
            kind: 'write_off',
          }),
        );
    }
    return out;
  }

  /** The balances a payment of `direction` can be allocated against, for validation. */
  private async balancesIn(
    tx: any,
    ctx: Ctx,
    partyId: string,
    direction: Direction,
  ): Promise<Map<string, bigint>> {
    const { documents } = await this.positionsIn(tx, ctx, '9999-12-31', partyId);
    return new Map(
      documents.filter((x) => PAYABLE[direction].has(x.type)).map((x) => [x.id, x.balancePaise]),
    );
  }

  private async validateIn(tx: any, ctx: Ctx, input: PaymentInput): Promise<bigint> {
    this.checkInputIn(input);
    const par = this.d.schema.parties;
    const [party]: Row[] = await tx
      .select({ id: par.id })
      .from(par)
      .where(
        and(eq(par.id, input.partyId), eq(par.business_id, ctx.businessId), isNull(par.deleted_at)),
      )
      .limit(1);
    if (!party) throw new NotFoundError('parties', input.partyId);
    const tcs = input.tcsPaise ?? 0n;
    if (tcs > 0n && input.direction !== 'received')
      throw new RuleError('TCS is collected on receipts only.');
    if (tcs >= input.amountPaise) throw new RuleError('TCS must be less than the amount received.');
    const consideration = input.amountPaise - tcs;
    const errors = validateAllocations({
      considerationPaise: consideration,
      allocations: input.allocations,
      balances: await this.balancesIn(tx, ctx, input.partyId, input.direction),
    });
    if (errors.length > 0) throw new RuleError(errors.join(' '));
    return consideration;
  }

  private voucherMetaIn(input: PaymentInput, payment: Row, numbers: Map<string, string>): Row {
    return {
      paymentId: payment['id'],
      mode: input.mode,
      reference: input.reference ?? null,
      chequeDate: input.chequeDate ?? null,
      tcsPaise: num(input.tcsPaise ?? 0n),
      allocations: input.allocations.map((a) => ({
        documentId: a.documentId,
        number: numbers.get(a.documentId) ?? null,
        amountPaise: num(a.amountPaise),
      })),
    };
  }

  private async docNumbersIn(tx: any, ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
    const docs = this.d.schema.documents;
    const rows: Row[] = ids.length
      ? await tx
          .select({ id: docs.id, number: docs.number })
          .from(docs)
          .where(eq(docs.business_id, ctx.businessId))
      : [];
    return new Map(
      rows.filter((r) => ids.includes(r['id']) && r['number']).map((r) => [r['id'], r['number']]),
    );
  }

  /**
   * Record a payment or receipt. Allocations are checked against what is owed, the remainder becomes
   * party credit, the ledger is posted, and a receipt gets its receipt voucher (own series) in the same
   * transaction. Nothing is written if anything fails.
   */
  async record(
    ctx: Ctx,
    input: PaymentInput,
    opts: { lockOverride?: LockOverride } = {},
  ): Promise<PaymentResult> {
    const run = () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        await this.lock.assertOpen(
          c,
          input.date,
          { action: 'payment', documentId: input.partyId },
          opts.lockOverride,
        );
        const consideration = await this.validateIn(tx, c, input);
        const wo = input.allocations.reduce((n, a) => n + (a.writeOffPaise ?? 0n), 0n);
        const payment: Row = await this.createIn(tx, c, {
          date: input.date,
          direction: input.direction,
          mode: input.mode,
          account_id: input.accountId ?? null,
          party_id: input.partyId,
          amount_paise: num(input.amountPaise),
          reference: input.reference?.trim() || null,
          cheque_date: input.chequeDate ?? null,
          notes: input.notes?.trim() || null,
          tcs_paise: num(input.tcsPaise ?? 0n),
          status: 'cleared',
        });
        const allocations = await this.writeAllocationsIn(tx, c, payment, input.allocations);
        await this.postLinesIn(tx, c, payment, this.postingsIn(input, wo));

        let voucher: Row | null = null;
        let saved = payment;
        if (input.direction === 'received') {
          const numbers = await this.docNumbersIn(
            tx,
            c,
            input.allocations.map((a) => a.documentId),
          );
          voucher = await this.createVoucherIn(tx, c, input, payment, numbers);
          saved = await this.updateIn(
            tx,
            c,
            payment['id'],
            { voucher_id: voucher['id'] },
            payment['version'],
          );
        }
        const used = input.allocations.reduce((n, a) => n + a.amountPaise, 0n);
        return { payment: saved, allocations, voucher, remainderPaise: consideration - used };
      });
    return ctx.tx ? run() : serialised(this.d, run);
  }

  private async createVoucherIn(
    tx: any,
    ctx: Ctx,
    input: PaymentInput,
    payment: Row,
    numbers: Map<string, string>,
  ): Promise<Row> {
    const business = await new BusinessRepo(this.d).get(ctx);
    const fyStart = Number(business?.['fy_start_month'] ?? 4);
    const { number, seriesId } = await this.flow.takeNumberIn(
      tx,
      ctx,
      'receipt_voucher',
      input.date,
      fyStart,
    );
    const par = this.d.schema.parties;
    const [party]: Row[] = await tx
      .select({ name: par.name })
      .from(par)
      .where(eq(par.id, input.partyId))
      .limit(1);
    return (this.flow as any).createIn(tx, ctx, {
      type: 'receipt_voucher',
      status: 'issued',
      number,
      series_id: seriesId,
      date: input.date,
      party_id: input.partyId,
      party_name: party?.['name'] ?? null,
      supply_type: 'intra',
      total_paise: num(input.amountPaise),
      metadata_json: this.voucherMetaIn(input, payment, numbers),
    });
  }

  /* ------------------------------------------------------------------ edit and delete */

  /**
   * Change a payment (amount, date, mode, reference, notes, allocations). The ledger is reversed and
   * posted again, and the receipt voucher gets a new revision. Credit already applied from the payment
   * must still be covered by what is left unallocated.
   */
  async edit(
    ctx: Ctx,
    id: string,
    expectedVersion: number,
    input: PaymentInput,
    opts: { lockOverride?: LockOverride } = {},
  ): Promise<PaymentResult> {
    const run = () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        const current = await this.getIn(tx, c, id);
        if (!current) throw new NotFoundError('payments', id);
        if (current['status'] !== 'cleared')
          throw new RuleError('Only a cleared payment can be edited.');
        if (current['party_id'] !== input.partyId || current['direction'] !== input.direction)
          throw new RuleError('The party and direction of a payment cannot change.');
        for (const date of new Set([String(current['date']), input.date]))
          await this.lock.assertOpen(
            c,
            date,
            { action: 'payment', documentId: id },
            opts.lockOverride,
          );

        // remove what it allocated (the credit applied from it stays), then check the new picture
        const all: Row[] = await this.allocationsOfIn(tx, c, id);
        let appliedFrom = 0n;
        for (const a of all) {
          if (a['kind'] === 'credit_applied') appliedFrom += big(a['amount_paise']);
          else await this.allocations.softDelete(c, a['id'], a['version']);
        }
        const consideration = await this.validateIn(tx, c, input);
        const used = input.allocations.reduce((n, a) => n + a.amountPaise, 0n);
        if (consideration - used < appliedFrom)
          throw new RuleError(
            'Credit from this payment has already been applied to other documents, so its amount cannot go below that.',
          );

        await this.reverseLedgerIn(tx, c, current, 'Edited: reversal');
        const updated: Row = await this.updateIn(
          tx,
          c,
          id,
          {
            date: input.date,
            mode: input.mode,
            account_id: input.accountId ?? null,
            amount_paise: num(input.amountPaise),
            reference: input.reference?.trim() || null,
            cheque_date: input.chequeDate ?? null,
            notes: input.notes?.trim() || null,
            tcs_paise: num(input.tcsPaise ?? 0n),
          },
          expectedVersion,
        );
        const allocations = await this.writeAllocationsIn(tx, c, updated, input.allocations);
        const wo = input.allocations.reduce((n, a) => n + (a.writeOffPaise ?? 0n), 0n);
        await this.postLinesIn(tx, c, updated, this.postingsIn(input, wo));

        let voucher: Row | null = null;
        if (updated['voucher_id']) {
          const v = await this.flow.get(c, updated['voucher_id']);
          if (v) {
            const numbers = await this.docNumbersIn(
              tx,
              c,
              input.allocations.map((a) => a.documentId),
            );
            voucher = await (this.flow as any).updateIn(
              tx,
              c,
              v['id'],
              {
                date: input.date,
                total_paise: num(input.amountPaise),
                revision: Number(v['revision'] ?? 1) + 1,
                metadata_json: this.voucherMetaIn(input, updated, numbers),
              },
              v['version'],
            );
          }
        }
        return { payment: updated, allocations, voucher, remainderPaise: consideration - used };
      });
    return ctx.tx ? run() : serialised(this.d, run);
  }

  /**
   * Make the receipt voucher for a received payment that has none (payments recorded before receipts
   * existed, or imported). The receipt is numbered in its own series and dated on the payment. Asking
   * again for a payment that already has one returns it unchanged.
   */
  async createReceipt(
    ctx: Ctx,
    paymentId: string,
    opts: { lockOverride?: LockOverride } = {},
  ): Promise<Row> {
    const run = () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        const payment = await this.getIn(tx, c, paymentId);
        if (!payment) throw new NotFoundError('payments', paymentId);
        if (payment['direction'] !== 'received')
          throw new RuleError('Receipts are made for money received, not for payments made.');
        if (payment['status'] !== 'cleared')
          throw new RuleError('Only a cleared payment has a receipt.');
        if (payment['voucher_id']) {
          const existing = await this.flow.get(c, payment['voucher_id']);
          if (existing) return existing;
        }
        await this.lock.assertOpen(
          c,
          String(payment['date']),
          { action: 'receipt', documentId: paymentId },
          opts.lockOverride,
        );
        const allocs = (await this.allocationsOfIn(tx, c, paymentId)).filter(
          (a) => a['kind'] === 'payment',
        );
        const input: PaymentInput = {
          direction: 'received',
          partyId: payment['party_id'],
          date: String(payment['date']),
          mode: payment['mode'],
          amountPaise: big(payment['amount_paise']),
          tcsPaise: big(payment['tcs_paise']),
          reference: payment['reference'] ?? null,
          chequeDate: payment['cheque_date'] ?? null,
          allocations: allocs.map((a) => ({
            documentId: a['document_id'],
            amountPaise: big(a['amount_paise']),
          })),
        };
        const numbers = await this.docNumbersIn(
          tx,
          c,
          input.allocations.map((a) => a.documentId),
        );
        const voucher = await this.createVoucherIn(tx, c, input, payment, numbers);
        await this.updateIn(tx, c, paymentId, { voucher_id: voucher['id'] }, payment['version']);
        return voucher;
      });
    return ctx.tx ? run() : serialised(this.d, run);
  }

  private async allocationsOfIn(tx: any, ctx: Ctx, paymentId: string): Promise<Row[]> {
    const al = this.d.schema.payment_allocations;
    return tx
      .select()
      .from(al)
      .where(
        and(
          eq(al.business_id, ctx.businessId),
          eq(al.payment_id, paymentId),
          isNull(al.deleted_at),
        ),
      );
  }

  /**
   * Delete a payment: reverse its ledger, remove its allocations and cancel its receipt voucher (the
   * number stays on record). Refused when credit from it has been applied to other documents, unless
   * `force` (which removes those applications too, putting those documents back as owed). Audited.
   * This is also what "undo" does.
   */
  async remove(
    ctx: Ctx,
    id: string,
    opts: { force?: boolean; lockOverride?: LockOverride } = {},
  ): Promise<{ payment: Row; unappliedDocuments: string[] }> {
    const run = () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        const current = await this.getIn(tx, c, id);
        if (!current) throw new NotFoundError('payments', id);
        await this.lock.assertOpen(
          c,
          String(current['date']),
          { action: 'payment', documentId: id },
          opts.lockOverride,
        );
        const mine = await this.allocationsOfIn(tx, c, id);
        const downstream = mine.filter((a) => a['kind'] === 'credit_applied');
        if (downstream.length > 0 && !opts.force) {
          const numbers = await this.docNumbersIn(
            tx,
            c,
            downstream.map((a) => a['document_id']),
          );
          throw new CreditAppliedError(
            'Credit from this payment has been applied to other documents. Remove those first, or delete anyway and they go back to unpaid.',
            downstream.map((a) => ({
              id: a['document_id'],
              number: numbers.get(a['document_id']) ?? null,
              amountPaise: Number(a['amount_paise']),
            })),
          );
        }
        for (const a of mine) await this.allocations.softDelete(c, a['id'], a['version']);
        await this.reverseLedgerIn(tx, c, current, 'Deleted: reversal');
        if (current['voucher_id']) {
          const v = await this.flow.get(c, current['voucher_id']);
          if (v && v['status'] === 'issued')
            await (this.flow as any).updateIn(
              tx,
              c,
              v['id'],
              { status: 'cancelled', cancelled_at: Date.now(), cancel_reason: 'Payment deleted' },
              v['version'],
            );
        }
        const payment = await this.softDelete(c, id, current['version']);
        return { payment, unappliedDocuments: downstream.map((a) => String(a['document_id'])) };
      });
    return ctx.tx ? run() : serialised(this.d, run);
  }

  /* ------------------------------------------------------------------ apply credit */

  /**
   * Use credit (an advance or a credit note) against a document. Each use is an allocation of kind
   * `credit_applied` linked to its source, so the source cannot be deleted without saying so (FR-053).
   * Never more than the source has left, or than the document owes.
   */
  async applyCredit(
    ctx: Ctx,
    input: {
      documentId: string;
      uses: { kind: 'payment' | 'document'; id: string; amountPaise: bigint }[];
    },
    today: string,
  ): Promise<Row[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const { documents } = await this.positionsIn(tx, c, today);
      const target = documents.find((x) => x.id === input.documentId);
      if (!target) throw new RuleError('That document is not open for payment.');
      const side = directionOfDoc(target.type)!;
      if (!target.partyId) throw new RuleError('The document has no party to take credit from.');
      const sources = await this.creditSourcesIn(tx, c, target.partyId, side, today);
      let total = 0n;
      const rows: Row[] = [];
      for (const u of input.uses) {
        if (u.amountPaise <= 0n) throw new RuleError('Credit applied must be more than zero.');
        const src = sources.find((s) => s.kind === u.kind && s.id === u.id);
        if (!src) throw new RuleError('That credit does not belong to this party or is used up.');
        if (u.amountPaise > src.remainingPaise)
          throw new RuleError(`Only ${src.remainingPaise} paise are left on ${src.label}.`);
        total += u.amountPaise;
      }
      if (total > target.balancePaise) throw new RuleError('More credit than the document owes.');
      for (const u of input.uses) {
        let voucher: string | null = null;
        if (u.kind === 'payment') {
          const p = await this.getIn(tx, c, u.id);
          voucher = (p?.['voucher_id'] as string | null) ?? null;
        }
        rows.push(
          await (this.allocations as any).createIn(tx, c, {
            payment_id: u.kind === 'payment' ? u.id : null,
            document_id: input.documentId,
            amount_paise: num(u.amountPaise),
            kind: 'credit_applied',
            source_document_id: u.kind === 'document' ? u.id : voucher,
          }),
        );
      }
      return rows;
    });
  }

  /** Plan how credit would be applied to a document, oldest first (the dialog shows it before it is used). */
  async planCredit(ctx: Ctx, documentId: string, today: string) {
    return runInTx(this.d, ctx, async (tx) => {
      const { documents } = await this.positionsIn(tx, ctx, today);
      const target = documents.find((x) => x.id === documentId);
      if (!target || !target.partyId || target.balancePaise <= 0n) return [];
      const sources = await this.creditSourcesIn(
        tx,
        ctx,
        target.partyId,
        directionOfDoc(target.type)!,
        today,
      );
      return planCreditApplication(sources, target.balancePaise);
    });
  }

  /* ------------------------------------------------------------------ lists and the day book */

  async listPayments(ctx: Ctx, f: PaymentFilters = {}): Promise<PaymentListRow[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const pay = this.d.schema.payments;
      const rows: Row[] = await tx
        .select()
        .from(pay)
        .where(
          and(
            eq(pay.business_id, ctx.businessId),
            isNull(pay.deleted_at),
            ...(f.partyId ? [eq(pay.party_id, f.partyId)] : []),
            ...(f.direction ? [eq(pay.direction, f.direction)] : []),
            ...(f.mode ? [eq(pay.mode, f.mode)] : []),
          ),
        );
      const par = this.d.schema.parties;
      const parties: Row[] = await tx
        .select({ id: par.id, name: par.name })
        .from(par)
        .where(eq(par.business_id, ctx.businessId));
      const names = new Map(parties.map((p) => [p['id'], p['name'] as string]));
      const docs = this.d.schema.documents;
      const vouchers: Row[] = await tx
        .select({ id: docs.id, number: docs.number })
        .from(docs)
        .where(and(eq(docs.business_id, ctx.businessId), eq(docs.type, 'receipt_voucher')));
      const vNo = new Map(vouchers.map((v) => [v['id'], (v['number'] as string | null) ?? null]));
      const al = this.d.schema.payment_allocations;
      const allocs: Row[] = await tx
        .select()
        .from(al)
        .where(and(eq(al.business_id, ctx.businessId), isNull(al.deleted_at)));
      const used = new Map<string, bigint>();
      for (const a of allocs) {
        if (!a['payment_id'] || a['kind'] === 'write_off') continue;
        used.set(a['payment_id'], (used.get(a['payment_id']) ?? 0n) + big(a['amount_paise']));
      }
      const q = f.q?.trim().toLowerCase();
      const out: PaymentListRow[] = [];
      for (const r of rows) {
        const date = String(r['date']);
        if (f.from && date < f.from) continue;
        if (f.to && date > f.to) continue;
        const row: PaymentListRow = {
          id: r['id'],
          date,
          direction: r['direction'],
          mode: r['mode'],
          partyId: (r['party_id'] as string | null) ?? null,
          partyName: names.get(r['party_id']) ?? '',
          amountPaise: big(r['amount_paise']),
          tcsPaise: big(r['tcs_paise']),
          allocatedPaise: used.get(r['id']) ?? 0n,
          unallocatedPaise:
            big(r['amount_paise']) - big(r['tcs_paise']) - (used.get(r['id']) ?? 0n),
          reference: (r['reference'] as string | null) ?? null,
          voucherId: (r['voucher_id'] as string | null) ?? null,
          voucherNumber: vNo.get(r['voucher_id']) ?? null,
          version: r['version'],
        };
        if (
          q &&
          !`${row.partyName} ${row.reference ?? ''} ${row.voucherNumber ?? ''}`
            .toLowerCase()
            .includes(q)
        )
          continue;
        out.push(row);
      }
      out.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
      return out.slice(0, f.limit ?? 500);
    });
  }

  /** The allocations of a payment with the document each settles (for the edit form and the voucher). */
  async allocationsFor(ctx: Ctx, paymentId: string): Promise<Row[]> {
    return runInTx(this.d, ctx, (tx) => this.allocationsOfIn(tx, ctx, paymentId));
  }

  /**
   * Cash in, cash out and the closing balance for one day, from the ledger's cash account (so it
   * agrees with the books). `closing` includes everything up to and including that day.
   */
  async dayBook(
    ctx: Ctx,
    date: string,
  ): Promise<{
    openingPaise: bigint;
    inPaise: bigint;
    outPaise: bigint;
    closingPaise: bigint;
    entries: { partyName: string; narration: string; inPaise: bigint; outPaise: bigint }[];
  }> {
    return runInTx(this.d, ctx, async (tx) => {
      const acc = this.d.schema.ledger_accounts;
      const [cash]: Row[] = await tx
        .select({ id: acc.id })
        .from(acc)
        .where(
          and(eq(acc.business_id, ctx.businessId), eq(acc.code, '1000'), isNull(acc.deleted_at)),
        )
        .limit(1);
      const empty = { openingPaise: 0n, inPaise: 0n, outPaise: 0n, closingPaise: 0n, entries: [] };
      if (!cash) return empty;
      const le = this.d.schema.ledger_entries;
      const rows: Row[] = await tx
        .select()
        .from(le)
        .where(
          and(
            eq(le.business_id, ctx.businessId),
            eq(le.account_id, cash['id']),
            isNull(le.deleted_at),
          ),
        );
      const par = this.d.schema.parties;
      const pay = this.d.schema.payments;
      const payRows: Row[] = await tx
        .select({ id: pay.id, party: pay.party_id })
        .from(pay)
        .where(eq(pay.business_id, ctx.businessId));
      const payParty = new Map(payRows.map((p) => [p['id'], p['party']]));
      const parties: Row[] = await tx
        .select({ id: par.id, name: par.name })
        .from(par)
        .where(eq(par.business_id, ctx.businessId));
      const names = new Map(parties.map((p) => [p['id'], p['name'] as string]));
      let opening = 0n;
      let closing = 0n;
      let inn = 0n;
      let out = 0n;
      const entries: { partyName: string; narration: string; inPaise: bigint; outPaise: bigint }[] =
        [];
      for (const r of rows) {
        const d = String(r['date']);
        const dr = big(r['debit_paise']);
        const cr = big(r['credit_paise']);
        if (d < date) opening += dr - cr;
        if (d <= date) closing += dr - cr;
        if (d === date) {
          inn += dr;
          out += cr;
          entries.push({
            partyName: names.get(payParty.get(r['payment_id'])) ?? '',
            narration: String(r['narration'] ?? ''),
            inPaise: dr,
            outPaise: cr,
          });
        }
      }
      return { openingPaise: opening, inPaise: inn, outPaise: out, closingPaise: closing, entries };
    });
  }
}

/* ------------------------------------------------------------------ business accounts */

export interface BusinessAccountInput {
  kind: 'bank' | 'upi' | 'cash' | 'wallet';
  name: string;
  holderName?: string | null;
  accountNo?: string | null;
  ifsc?: string | null;
  accountType?: string | null;
  upiId?: string | null;
  isDefault?: boolean;
  showOnDocuments?: boolean;
}

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;

/** Bank, UPI, cash and wallet accounts money is received into or paid from. */
export class BusinessAccountRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'business_accounts');
  }

  private rowOfIn(i: BusinessAccountInput): NewRow {
    const name = i.name.trim();
    if (!name) throw new RuleError('Give the account a name.');
    if (i.kind === 'bank') {
      if (i.ifsc && !IFSC.test(i.ifsc.trim().toUpperCase()))
        throw new RuleError(
          'The IFSC code looks wrong. It is 4 letters, a zero, then 6 letters or digits.',
        );
      if (i.accountNo && !/^\d{6,18}$/.test(i.accountNo.trim()))
        throw new RuleError('An account number is 6 to 18 digits.');
    }
    if (i.kind === 'upi') {
      if (!i.upiId || !UPI.test(i.upiId.trim()))
        throw new RuleError('The UPI ID looks wrong (name@bank).');
    }
    return {
      kind: i.kind,
      name,
      holder_name: i.holderName?.trim() || null,
      account_no: i.accountNo?.trim() || null,
      ifsc: i.ifsc?.trim().toUpperCase() || null,
      account_type: i.accountType?.trim() || null,
      upi_id: i.upiId?.trim() || null,
      is_default: !!i.isDefault,
      show_on_documents: i.showOnDocuments ?? true,
    };
  }

  private async clearDefaultsIn(tx: any, ctx: Ctx, exceptId: string | null): Promise<void> {
    for (const r of await this.listIn(tx, ctx))
      if (r['is_default'] && r['id'] !== exceptId)
        await this.updateIn(tx, ctx, r['id'], { is_default: false }, r['version']);
  }

  private async listIn(tx: any, ctx: Ctx): Promise<Row[]> {
    const t = this.t;
    return tx
      .select()
      .from(t)
      .where(and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at)))
      .orderBy(t.created_at);
  }

  async listAccounts(ctx: Ctx): Promise<Row[]> {
    return runInTx(this.d, ctx, (tx) => this.listIn(tx, ctx));
  }

  async createAccount(ctx: Ctx, input: BusinessAccountInput): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const first = (await this.listIn(tx, c)).length === 0;
      const row = this.rowOfIn({ ...input, isDefault: input.isDefault || first });
      if (row['is_default']) await this.clearDefaultsIn(tx, c, null);
      return this.createIn(tx, c, row);
    });
  }

  async updateAccount(
    ctx: Ctx,
    id: string,
    expectedVersion: number,
    input: BusinessAccountInput,
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const row = this.rowOfIn(input);
      if (row['is_default']) await this.clearDefaultsIn(tx, c, id);
      return this.updateIn(tx, c, id, row, expectedVersion);
    });
  }

  /** Remove an account; one that payments were received into is kept in history, so only archived. */
  async removeAccount(ctx: Ctx, id: string, expectedVersion: number): Promise<Row> {
    return this.softDelete(ctx, id, expectedVersion);
  }

  /** The accounts to print on documents and receipts. */
  async forDocuments(ctx: Ctx): Promise<Row[]> {
    return (await this.listAccounts(ctx)).filter((r) => r['show_on_documents']);
  }
}

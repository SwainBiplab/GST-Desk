/**
 * Counter billing (prompt 52, FR-113 and FR-114). A counter has its own number series (so two tills never
 * take each other's numbers, and a till can be given a reserved range when devices sync); a shift is one
 * cashier's turn, opened with a float and closed with the cash counted; a sale is one transaction that
 * issues the bill, settles it over the modes the customer paid with, and records which shift took the money.
 * Returns are credit notes against a bill, refunded in cash or back to the mode paid. Held bills, the shift
 * report and the day's Z report are read from the same rows. Every figure on a bill comes from the document
 * engine; the rules for tenders, the drawer and the Z report are in `@gst/domain/pos`.
 */
import {
  buildZReport,
  closeVariance,
  draftFromRows,
  draftToRows,
  emptyDraft,
  settleTenders,
  type BillFacts,
  type DraftDocument,
  type DraftLine,
  type TenderSettlement,
  type Tender,
  type TenderMode,
  type ZReport,
} from '@gst/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { Row } from '../schema';

import { BusinessRepo, PartyRepo } from './aggregates';
import { BaseRepo, NotFoundError, RuleError, runInTx, type Ctx } from './base';
import { DocumentFlowRepo, serialised } from './document-flow';
import { NumberingRepo } from './numbering';
import { PaymentFlowRepo } from './payment-flow';

const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => (v == null ? '' : String(v));
const big = (v: unknown): bigint => BigInt(Math.round(Number(v ?? 0)));

export interface Counter {
  id: string;
  name: string;
  seriesKey: string;
  documentType: 'tax_invoice' | 'bill_of_supply';
  isActive: boolean;
  version: number;
}

const toCounter = (r: Row): Counter => ({
  id: s(r['id']),
  name: s(r['name']),
  seriesKey: s(r['series_key']),
  documentType: (s(r['document_type']) || 'tax_invoice') as Counter['documentType'],
  isActive: r['is_active'] !== false && Number(r['is_active']) !== 0,
  version: n(r['version']),
});

export interface Shift {
  id: string;
  counterId: string;
  cashier: string;
  openedAt: number;
  openingFloatPaise: bigint;
  status: 'open' | 'closed';
  closedAt: number | null;
  expectedCashPaise: bigint | null;
  countedCashPaise: bigint | null;
  variancePaise: bigint | null;
  note: string;
  version: number;
}

const toShift = (r: Row): Shift => ({
  id: s(r['id']),
  counterId: s(r['counter_id']),
  cashier: s(r['cashier']),
  openedAt: n(r['opened_at']),
  openingFloatPaise: big(r['opening_float_paise']),
  status: s(r['status']) === 'closed' ? 'closed' : 'open',
  closedAt: r['closed_at'] == null ? null : n(r['closed_at']),
  expectedCashPaise: r['expected_cash_paise'] == null ? null : big(r['expected_cash_paise']),
  countedCashPaise: r['counted_cash_paise'] == null ? null : big(r['counted_cash_paise']),
  variancePaise: r['variance_paise'] == null ? null : big(r['variance_paise']),
  note: s(r['note']),
  version: n(r['version']),
});

export interface HeldBill {
  id: string;
  counterId: string;
  label: string;
  partyId: string | null;
  lines: DraftLine[];
  totalPaise: bigint;
  at: number;
}

/** The cart as it is kept: plain numbers and strings, nothing JSON cannot carry. */
interface StoredLine {
  key: string;
  itemId: string | null;
  description: string;
  hsn: string;
  qty: string;
  unitId: string | null;
  rate: string;
  discount: string;
  inclusive: boolean;
  gstRateBp: number;
  cessBp: number;
  taxability: DraftLine['taxability'];
  note: string;
  godownId: string | null;
  batchId: string | null;
  serials: string[];
}

const storeLine = (l: DraftLine): StoredLine => ({
  key: l.key,
  itemId: l.itemId,
  description: l.description,
  hsn: l.hsn,
  qty: String(l.qtyMicros),
  unitId: l.unitId,
  rate: String(l.ratePaise),
  discount: String(l.discountValue),
  inclusive: l.inclusive,
  gstRateBp: l.gstRateBp,
  cessBp: l.cessBp,
  taxability: l.taxability,
  note: l.note,
  godownId: l.godownId,
  batchId: l.batchId,
  serials: l.serials,
});

const loadLine = (x: StoredLine): DraftLine => ({
  key: x.key,
  itemId: x.itemId,
  description: x.description,
  hsn: x.hsn,
  qtyMicros: BigInt(x.qty),
  unitId: x.unitId,
  ratePaise: BigInt(x.rate),
  discountValue: BigInt(x.discount),
  inclusive: x.inclusive,
  gstRateBp: x.gstRateBp,
  cessBp: x.cessBp,
  taxability: x.taxability,
  note: x.note,
  godownId: x.godownId,
  batchId: x.batchId,
  serials: x.serials ?? [],
});

const asList = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      return JSON.parse(v) as unknown[];
    } catch {
      return [];
    }
  }
  return [];
};

export interface SaleInput {
  shiftId: string;
  /** The cart; blank lines are dropped. A line's discount is a percentage in basis points. */
  lines: DraftLine[];
  /** A customer; the walk-in customer when absent. */
  partyId?: string | null;
  tenders: Tender[];
  date: string;
  /** Post stock movements (the business's inventory flag). */
  inventoryEnabled?: boolean;
  /** The cashier, for the audit trail's sake. */
  note?: string;
}

export interface SaleResult {
  document: Row;
  settlement: TenderSettlement;
  billId: string;
  /** The documents and payments made, for printing. */
  paymentIds: string[];
}

export interface ReturnInput {
  shiftId: string;
  sourceDocumentId: string;
  /** What comes back: the bill's line (by its position, from 1) and the quantity. */
  lines: { lineNo: number; qtyMicros: bigint }[];
  /** How the refund is given: cash from the drawer, or back to the mode the customer paid with. */
  refundMode: TenderMode;
  date: string;
  inventoryEnabled?: boolean;
  reference?: string;
}

export interface BillLookup {
  document: Row;
  lines: (Row & { returnedMicros: bigint })[];
  /** True once every unit has been returned. */
  fullyReturned: boolean;
}

export interface ShiftReport {
  shift: Shift;
  counter: Counter | null;
  z: ZReport;
  movements: { id: string; kind: 'in' | 'out'; amountPaise: bigint; reason: string; at: number }[];
  bills: {
    id: string;
    documentId: string;
    number: string;
    kind: 'sale' | 'return';
    totalPaise: bigint;
    at: number;
  }[];
}

export class PosRepo {
  private readonly counters: BaseRepo;
  private readonly shifts: BaseRepo;
  private readonly moves: BaseRepo;
  private readonly bills: BaseRepo;
  private readonly held: BaseRepo;

  constructor(private readonly d: Database) {
    this.counters = new BaseRepo(d, 'pos_counters');
    this.shifts = new BaseRepo(d, 'pos_shifts');
    this.moves = new BaseRepo(d, 'pos_cash_movements');
    this.bills = new BaseRepo(d, 'pos_bills');
    this.held = new BaseRepo(d, 'pos_held_bills');
  }

  /* -------------------------------------------------------------- the walk-in customer */

  /** The customer a counter sale goes to when nobody is named: made once, unregistered, in the business's state. */
  async walkInPartyId(ctx: Ctx): Promise<string> {
    return runInTx(this.d, ctx, (tx) => this.walkInIn(tx, ctx));
  }

  private async walkInIn(tx: any, ctx: Ctx): Promise<string> {
    const p = this.d.schema.parties;
    const rows: Row[] = await tx
      .select({ id: p.id, name: p.name })
      .from(p)
      .where(
        and(
          eq(p.business_id, ctx.businessId),
          eq(p.name, 'Walk-in customer'),
          isNull(p.deleted_at),
        ),
      )
      .limit(1);
    if (rows[0]) return s(rows[0]['id']);
    const business = await new BusinessRepo(this.d).get({ ...ctx, tx });
    const created = await new PartyRepo(this.d).create(
      { ...ctx, tx },
      {
        type: 'customer',
        name: 'Walk-in customer',
        state_code: business?.['state_code'] ?? null,
        is_unregistered: true,
        country: 'India',
      },
    );
    return s(created['id']);
  }

  /* -------------------------------------------------------------- counters */

  async allCounters(ctx: Ctx): Promise<Counter[]> {
    return runInTx(this.d, ctx, async (tx) => {
      return (await this.allCountersIn(tx, ctx)).filter((c) => c.isActive);
    });
  }

  /** Make a counter and its own number series (`<prefix>/26-27/0001`): a till's bills never share numbers. */
  async addCounter(ctx: Ctx, input: { name: string; prefix?: string }): Promise<Counter> {
    return serialised(this.d, () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        const name = input.name.trim();
        if (name.length < 1) throw new RuleError('Give the counter a name.');
        const existing = await this.allCountersIn(tx, c);
        if (existing.some((x) => x.name.toLowerCase() === name.toLowerCase()))
          throw new RuleError('A counter with this name already exists.');
        const business = await new BusinessRepo(this.d).get(c);
        const type = business?.['scheme'] === 'composition' ? 'bill_of_supply' : 'tax_invoice';
        // "Counter 1" gives C1 and "Counter 2" gives C2; a name without a number gives its first four letters
        const alnum = name.replace(/[^A-Za-z0-9]/g, '');
        const digits = /\d+$/.exec(alnum)?.[0] ?? '';
        const letters = alnum.replace(/\d+$/, '').slice(0, digits ? 1 : 4);
        const prefix = (input.prefix ?? `${letters}${digits}`.toUpperCase()) || 'POS';
        const series = await new NumberingRepo(this.d).createSeries(c, {
          documentType: type,
          name: `Counter ${name}`,
          prefix: `${prefix}/`,
          padding: 4,
          reset: 'fy',
        });
        const row = await (this.counters as any).createIn(tx, c, {
          name,
          series_key: series.key,
          document_type: type,
          is_active: true,
        });
        return toCounter(row);
      }),
    );
  }

  private async allCountersIn(tx: any, ctx: Ctx): Promise<Counter[]> {
    const t = this.d.schema.pos_counters;
    const rows: Row[] = await tx
      .select()
      .from(t)
      .where(and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at)))
      .orderBy(asc(t.created_at));
    return rows.map(toCounter);
  }

  /** Give a counter a block of its series' numbers to bill from while the device is cut off from the others. */
  async reserveNumbers(
    ctx: Ctx,
    counterId: string,
    size: number,
    date: string,
  ): Promise<{ id: string; from: number; to: number }> {
    const counter = (await this.allCounters(ctx)).find((x) => x.id === counterId);
    if (!counter) throw new NotFoundError('pos_counters', counterId);
    return new NumberingRepo(this.d).reserveRange(ctx, counter.seriesKey, size, date);
  }

  /* -------------------------------------------------------------- shifts */

  async currentShift(ctx: Ctx, counterId: string): Promise<Shift | null> {
    return runInTx(this.d, ctx, (tx) => this.openShiftIn(tx, ctx, counterId));
  }

  private async openShiftIn(tx: any, ctx: Ctx, counterId: string): Promise<Shift | null> {
    const t = this.d.schema.pos_shifts;
    const [row]: Row[] = await tx
      .select()
      .from(t)
      .where(
        and(
          eq(t.business_id, ctx.businessId),
          eq(t.counter_id, counterId),
          eq(t.status, 'open'),
          isNull(t.deleted_at),
        ),
      )
      .limit(1);
    return row ? toShift(row) : null;
  }

  async openShift(
    ctx: Ctx,
    input: { counterId: string; floatPaise: bigint; cashier?: string; now?: number },
  ): Promise<Shift> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      if (input.floatPaise < 0n) throw new RuleError('The float cannot be negative.');
      const counter = (await this.allCountersIn(tx, c)).find((x) => x.id === input.counterId);
      if (!counter || !counter.isActive) throw new NotFoundError('pos_counters', input.counterId);
      if (await this.openShiftIn(tx, c, input.counterId))
        throw new RuleError('This counter already has a shift open. Close it first.');
      const row = await (this.shifts as any).createIn(tx, c, {
        counter_id: input.counterId,
        cashier: input.cashier ?? ctx.actor,
        opened_at: input.now ?? Date.now(),
        opening_float_paise: Number(input.floatPaise),
        status: 'open',
      });
      return toShift(row);
    });
  }

  /** Cash put in or taken out of the drawer by hand, with a reason. */
  async cashMovement(
    ctx: Ctx,
    input: { shiftId: string; kind: 'in' | 'out'; amountPaise: bigint; reason: string },
  ): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const shift = await this.shiftIn(tx, c, input.shiftId);
      if (shift.status !== 'open') throw new RuleError('This shift is closed.');
      if (input.amountPaise <= 0n) throw new RuleError('Give an amount above zero.');
      if (!input.reason.trim()) throw new RuleError('Say what the cash was for.');
      await (this.moves as any).createIn(tx, c, {
        shift_id: input.shiftId,
        kind: input.kind,
        amount_paise: Number(input.amountPaise),
        reason: input.reason.trim(),
      });
    });
  }

  private async shiftIn(tx: any, ctx: Ctx, id: string): Promise<Shift> {
    const row = await (this.shifts as any).getIn(tx, ctx, id);
    if (!row) throw new NotFoundError('pos_shifts', id);
    return toShift(row);
  }

  /* -------------------------------------------------------------- held bills */

  async hold(
    ctx: Ctx,
    input: {
      counterId: string;
      lines: DraftLine[];
      partyId?: string | null;
      label?: string;
      totalPaise?: bigint;
    },
  ): Promise<HeldBill> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const lines = input.lines.filter((l) => l.itemId || l.description.trim() !== '');
      if (lines.length === 0) throw new RuleError('There is nothing on the bill to hold.');
      const row = await (this.held as any).createIn(tx, c, {
        counter_id: input.counterId,
        label: input.label?.trim() || null,
        party_id: input.partyId ?? null,
        cart_json: lines.map(storeLine),
        total_paise: Number(input.totalPaise ?? 0n),
      });
      return this.toHeld(row);
    });
  }

  private toHeld(r: Row): HeldBill {
    return {
      id: s(r['id']),
      counterId: s(r['counter_id']),
      label: s(r['label']),
      partyId: r['party_id'] == null ? null : s(r['party_id']),
      lines: (asList(r['cart_json']) as StoredLine[]).map(loadLine),
      totalPaise: big(r['total_paise']),
      at: n(r['created_at']),
    };
  }

  async heldBills(ctx: Ctx, counterId?: string): Promise<HeldBill[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.d.schema.pos_held_bills;
      const rows: Row[] = await tx
        .select()
        .from(t)
        .where(
          and(
            eq(t.business_id, ctx.businessId),
            isNull(t.deleted_at),
            ...(counterId ? [eq(t.counter_id, counterId)] : []),
          ),
        )
        .orderBy(asc(t.created_at));
      return rows.map((r) => this.toHeld(r));
    });
  }

  /** Take a held bill back: it is returned and removed from the held list in one step. */
  async recall(ctx: Ctx, id: string): Promise<HeldBill> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const row = await (this.held as any).getIn(tx, c, id);
      if (!row) throw new NotFoundError('pos_held_bills', id);
      await this.held.softDelete(c, id, n(row['version']));
      return this.toHeld(row);
    });
  }

  async dropHeld(ctx: Ctx, id: string): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const row = await (this.held as any).getIn(tx, c, id);
      if (row) await this.held.softDelete(c, id, n(row['version']));
    });
  }

  /* -------------------------------------------------------------- selling */

  /** What a cart comes to, from the engine (so the screen and the bill never disagree). */
  async draftFor(
    ctx: Ctx,
    lines: DraftLine[],
    partyId: string | null,
    date: string,
  ): Promise<DraftDocument> {
    return runInTx(this.d, ctx, (tx) => this.draftIn(tx, ctx, lines, partyId, date, 'tax_invoice'));
  }

  private async draftIn(
    tx: any,
    ctx: Ctx,
    lines: DraftLine[],
    partyId: string | null,
    date: string,
    type: 'tax_invoice' | 'bill_of_supply' | 'credit_note',
  ): Promise<DraftDocument> {
    const c: Ctx = { ...ctx, tx };
    const business = await new BusinessRepo(this.d).get(c);
    const state = s(business?.['state_code']);
    const party = partyId ? await new PartyRepo(this.d).get(c, partyId) : null;
    const draft = emptyDraft(type, date, {
      supplierState: state,
      composition: business?.['scheme'] === 'composition',
    });
    const live = lines.filter((l) => l.itemId || l.description.trim() !== '');
    const percent = live.some((l) => l.discountValue > 0n);
    return {
      ...draft,
      partyId,
      partyName: party ? s(party['name']) : '',
      partyGstin: party?.['gstin'] ? s(party['gstin']) : null,
      partyState: party?.['state_code'] ? s(party['state_code']) : null,
      placeOfSupply: party?.['state_code'] ? s(party['state_code']) : state,
      discountMode: percent ? 'percent' : 'none',
      lines: live,
    };
  }

  /**
   * Issue the bill, settle it over the tenders and record the shift it belongs to: all or nothing. The
   * tenders are checked before anything is written (card and UPI exact, cash may be more and gives change).
   */
  async sell(ctx: Ctx, input: SaleInput): Promise<SaleResult> {
    return serialised(this.d, () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        const shift = await this.shiftIn(tx, c, input.shiftId);
        if (shift.status !== 'open')
          throw new RuleError('This shift is closed. Open a new one to sell.');
        const counter = (await this.allCountersIn(tx, c)).find((x) => x.id === shift.counterId);
        if (!counter) throw new NotFoundError('pos_counters', shift.counterId);
        const partyId = input.partyId ?? (await this.walkInIn(tx, c));
        const draft = await this.draftIn(
          tx,
          c,
          input.lines,
          partyId,
          input.date,
          counter.documentType,
        );
        if (draft.lines.length === 0) throw new RuleError('There is nothing on the bill.');
        const rows = draftToRows(draft);
        const total = BigInt(rows.doc.total_paise);
        const settlement = settleTenders(total, input.tenders);
        if (!settlement.ok) {
          throw new RuleError(
            settlement.errors.includes('short')
              ? `The payments fall short of the bill by ${settlement.shortPaise} paise.`
              : `The payments do not fit the bill (${settlement.errors.join(', ')}).`,
          );
        }
        const flow = new DocumentFlowRepo(this.d);
        const saved = await flow.saveDraft(c, {
          doc: rows.doc as unknown as Record<string, unknown>,
          lines: rows.lines as unknown as Record<string, unknown>[],
        });
        const issued = await flow.issueDraft(c, saved.document['id'], saved.document['version'], {
          ...(input.inventoryEnabled ? { inventoryEnabled: true } : {}),
          seriesKey: counter.seriesKey,
          shell: 'shop',
        });
        const document = issued.document;
        const pay = new PaymentFlowRepo(this.d);
        const paymentIds: string[] = [];
        for (const a of settlement.applied) {
          const r = await pay.record(
            c,
            {
              direction: 'received',
              partyId,
              date: input.date,
              mode: a.mode,
              amountPaise: a.amountPaise,
              reference: a.reference || null,
              notes: `Counter ${counter.name}`,
              allocations: [{ documentId: s(document['id']), amountPaise: a.amountPaise }],
            },
            { skipVoucher: true },
          );
          paymentIds.push(s(r.payment['id']));
        }
        const bill = await (this.bills as any).createIn(tx, c, {
          document_id: document['id'],
          shift_id: shift.id,
          counter_id: counter.id,
          kind: 'sale',
          tenders_json: settlement.applied.map((a) => ({
            mode: a.mode,
            amountPaise: String(a.amountPaise),
            reference: a.reference,
          })),
          change_paise: Number(settlement.changePaise),
          total_paise: Number(total),
        });
        return { document, settlement, billId: s(bill['id']), paymentIds };
      }),
    );
  }

  /* -------------------------------------------------------------- returns */

  /** Find a bill by its number and say what has already come back, so a return cannot take more than was sold. */
  async findBill(ctx: Ctx, number: string): Promise<BillLookup | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const docs = this.d.schema.documents;
      const [doc]: Row[] = await tx
        .select()
        .from(docs)
        .where(
          and(
            eq(docs.business_id, ctx.businessId),
            eq(docs.number, number.trim()),
            eq(docs.status, 'issued'),
            isNull(docs.deleted_at),
          ),
        )
        .limit(1);
      if (!doc || !['tax_invoice', 'bill_of_supply'].includes(s(doc['type']))) return null;
      const lines = await this.linesWithReturnsIn(tx, ctx, doc);
      return {
        document: doc,
        lines,
        fullyReturned: lines.every((l) => l.returnedMicros >= big(l['qty_micros'])),
      };
    });
  }

  private async linesWithReturnsIn(
    tx: any,
    ctx: Ctx,
    doc: Row,
  ): Promise<(Row & { returnedMicros: bigint })[]> {
    const dl = this.d.schema.document_lines;
    const lines: Row[] = await tx
      .select()
      .from(dl)
      .where(
        and(
          eq(dl.document_id, doc['id']),
          eq(dl.business_id, ctx.businessId),
          isNull(dl.deleted_at),
        ),
      )
      .orderBy(asc(dl.line_no));
    // what came back is kept with the return, by the bill's own line numbers (a credit note numbers its lines afresh)
    const returned = await queryRows(
      this.d,
      tx,
      sql`SELECT b.returned_json FROM pos_bills b JOIN documents d ON d.id = b.document_id
          WHERE b.business_id = ${ctx.businessId} AND b.deleted_at IS NULL AND b.kind = 'return'
            AND b.source_document_id = ${doc['id']} AND d.status = 'issued'`,
    );
    const by = new Map<number, bigint>();
    for (const r of returned)
      for (const x of asList(r['returned_json']) as { lineNo: number; qtyMicros: string }[])
        by.set(x.lineNo, (by.get(x.lineNo) ?? 0n) + BigInt(x.qtyMicros));
    return lines.map((l) => ({ ...l, returnedMicros: by.get(n(l['line_no'])) ?? 0n }));
  }

  /**
   * Take goods back against a bill: a credit note for the lines and quantities, then the refund. Cash comes out
   * of the drawer; card or UPI goes back the way it came. The quantity cannot exceed what is left to return.
   */
  async sellReturn(
    ctx: Ctx,
    input: ReturnInput,
  ): Promise<{ creditNote: Row; refundPaise: bigint }> {
    return serialised(this.d, () =>
      runInTx(this.d, ctx, async (tx) => {
        const c: Ctx = { ...ctx, tx };
        const shift = await this.shiftIn(tx, c, input.shiftId);
        if (shift.status !== 'open') throw new RuleError('This shift is closed.');
        const flow = new DocumentFlowRepo(this.d);
        const src = await flow.load(c, input.sourceDocumentId);
        if (!src || src.document['status'] !== 'issued')
          throw new RuleError('That bill cannot be returned against.');
        if (input.lines.length === 0) throw new RuleError('Choose what is coming back.');
        const withReturns = await this.linesWithReturnsIn(tx, c, src.document);
        const original = draftFromRows(src.document as never, src.lines as never, () =>
          crypto.randomUUID(),
        );
        const picked: DraftLine[] = [];
        for (const want of input.lines) {
          if (want.qtyMicros <= 0n) throw new RuleError('A returned quantity is above zero.');
          const row = withReturns.find((l) => n(l['line_no']) === want.lineNo);
          if (!row) throw new RuleError(`The bill has no line ${want.lineNo}.`);
          const left = big(row['qty_micros']) - row.returnedMicros;
          if (want.qtyMicros > left)
            throw new RuleError(`Line ${want.lineNo}: only ${Number(left) / 1e6} left to return.`);
          const base = original.lines[want.lineNo - 1];
          if (!base) throw new RuleError(`The bill has no line ${want.lineNo}.`);
          // the discount is per unit in value terms: keep the line's rate and discount, scale the quantity
          picked.push({
            ...base,
            qtyMicros: want.qtyMicros,
            serials: base.serials.slice(0, Number(want.qtyMicros / 1_000_000n)),
          });
        }
        const draft = await this.draftIn(
          tx,
          c,
          picked,
          src.document['party_id'] as string | null,
          input.date,
          'credit_note',
        );
        const rows = draftToRows({ ...draft, discountMode: original.discountMode });
        const saved = await flow.saveDraft(c, {
          doc: rows.doc as unknown as Record<string, unknown>,
          lines: rows.lines as unknown as Record<string, unknown>[],
          sourceDocumentId: input.sourceDocumentId,
        });
        const issued = await flow.issueDraft(c, saved.document['id'], saved.document['version'], {
          ...(input.inventoryEnabled ? { inventoryEnabled: true } : {}),
          shell: 'shop',
        });
        const creditNote = issued.document;
        const refund = BigInt(creditNote['total_paise'] as number);
        const pay = new PaymentFlowRepo(this.d);
        await pay.recordRefund(c, {
          creditNoteId: s(creditNote['id']),
          date: input.date,
          amountPaise: refund,
          reference: input.reference ?? `Counter return of ${s(src.document['number'])}`,
          mode: input.refundMode === 'other' ? 'other' : input.refundMode,
        });
        await (this.bills as any).createIn(tx, c, {
          document_id: creditNote['id'],
          shift_id: shift.id,
          counter_id: shift.counterId,
          kind: 'return',
          tenders_json: [{ mode: input.refundMode, amountPaise: String(refund), reference: '' }],
          change_paise: 0,
          total_paise: Number(refund),
          source_document_id: input.sourceDocumentId,
          returned_json: input.lines.map((x) => ({
            lineNo: x.lineNo,
            qtyMicros: String(x.qtyMicros),
          })),
        });
        return { creditNote, refundPaise: refund };
      }),
    );
  }

  /* -------------------------------------------------------------- closing and reports */

  private async factsIn(tx: any, ctx: Ctx, where: ReturnType<typeof sql>) {
    return queryRows(
      this.d,
      tx,
      sql`SELECT b.id, b.document_id, b.shift_id, b.kind, b.tenders_json, b.total_paise, b.created_at,
                 d.number, d.total_taxable_paise, d.total_cgst_paise, d.total_sgst_paise, d.total_utgst_paise,
                 d.total_igst_paise, d.total_cess_paise
          FROM pos_bills b JOIN documents d ON d.id = b.document_id
          WHERE b.business_id = ${ctx.businessId} AND b.deleted_at IS NULL AND d.status = 'issued' AND ${where}
          ORDER BY b.created_at, b.id`,
    );
  }

  private billFacts(r: Record<string, any>): BillFacts {
    return {
      kind: s(r['kind']) === 'return' ? 'return' : 'sale',
      totalPaise: big(r['total_paise']),
      taxablePaise: big(r['total_taxable_paise']),
      cgstPaise: big(r['total_cgst_paise']),
      // UTGST sits with SGST on a counter's tax summary: both are the state half
      sgstPaise: big(r['total_sgst_paise']) + big(r['total_utgst_paise']),
      igstPaise: big(r['total_igst_paise']),
      cessPaise: big(r['total_cess_paise']),
      tenders: (asList(r['tenders_json']) as { mode: TenderMode; amountPaise: string }[]).map(
        (t) => ({
          mode: t.mode,
          amountPaise: BigInt(t.amountPaise),
        }),
      ),
    };
  }

  /** The shift's report: the Z report, the cash movements and the bills it took. */
  async shiftReport(ctx: Ctx, shiftId: string): Promise<ShiftReport> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const shift = await this.shiftIn(tx, c, shiftId);
      const rows = await this.factsIn(tx, c, sql`b.shift_id = ${shiftId}`);
      const mt = this.d.schema.pos_cash_movements;
      const mv: Row[] = await tx
        .select()
        .from(mt)
        .where(
          and(eq(mt.business_id, ctx.businessId), eq(mt.shift_id, shiftId), isNull(mt.deleted_at)),
        )
        .orderBy(asc(mt.created_at));
      const movements = mv.map((m) => ({
        id: s(m['id']),
        kind: (s(m['kind']) === 'out' ? 'out' : 'in') as 'in' | 'out',
        amountPaise: big(m['amount_paise']),
        reason: s(m['reason']),
        at: n(m['created_at']),
      }));
      const counter =
        (await this.allCountersIn(tx, c)).find((x) => x.id === shift.counterId) ?? null;
      return {
        shift,
        counter,
        z: buildZReport(
          rows.map((r) => this.billFacts(r)),
          movements,
          shift.openingFloatPaise,
        ),
        movements,
        bills: rows.map((r) => ({
          id: s(r['id']),
          documentId: s(r['document_id']),
          number: s(r['number']),
          kind: (s(r['kind']) === 'return' ? 'return' : 'sale') as 'sale' | 'return',
          totalPaise: big(r['total_paise']),
          at: n(r['created_at']),
        })),
      };
    });
  }

  /** Close the shift with the cash counted: the variance (counted less expected) is recorded with it. */
  async closeShift(
    ctx: Ctx,
    input: { shiftId: string; countedPaise: bigint; note?: string; now?: number },
  ): Promise<{
    shift: Shift;
    z: ZReport;
    variancePaise: bigint;
    status: 'balanced' | 'short' | 'over';
  }> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      if (input.countedPaise < 0n) throw new RuleError('The cash counted cannot be negative.');
      const shift = await this.shiftIn(tx, c, input.shiftId);
      if (shift.status !== 'open') throw new RuleError('This shift is already closed.');
      const report = await this.shiftReport(c, input.shiftId);
      const v = closeVariance(report.z.drawer.expectedPaise, input.countedPaise);
      const updated = await (this.shifts as any).updateIn(
        tx,
        c,
        input.shiftId,
        {
          status: 'closed',
          closed_at: input.now ?? Date.now(),
          expected_cash_paise: Number(report.z.drawer.expectedPaise),
          counted_cash_paise: Number(input.countedPaise),
          variance_paise: Number(v.variancePaise),
          note: input.note?.trim() || null,
        },
        shift.version,
      );
      return {
        shift: toShift(updated),
        z: report.z,
        variancePaise: v.variancePaise,
        status: v.status,
      };
    });
  }

  /** Every shift of a day, newest first, with each one's variance (the day-close report reads this). */
  async shiftsOfDay(ctx: Ctx, day: string): Promise<(Shift & { counterName: string })[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const start = Date.parse(`${day}T00:00:00+05:30`);
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT sh.*, c.name AS counter_name FROM pos_shifts sh JOIN pos_counters c ON c.id = sh.counter_id
            WHERE sh.business_id = ${ctx.businessId} AND sh.deleted_at IS NULL
              AND sh.opened_at >= ${start} AND sh.opened_at < ${start + 86_400_000}
            ORDER BY sh.opened_at DESC`,
      );
      return rows.map((r) => ({ ...toShift(r as Row), counterName: s(r['counter_name']) }));
    });
  }

  /** The day's Z report across every counter: what was sold and returned, by mode and tax. */
  async dayReport(
    ctx: Ctx,
    day: string,
  ): Promise<{ z: ZReport; shifts: number; counters: number }> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const shifts = await this.shiftsOfDay(c, day);
      const ids = shifts.map((x) => x.id);
      if (ids.length === 0) return { z: buildZReport([], [], 0n), shifts: 0, counters: 0 };
      const rows = await this.factsIn(
        tx,
        c,
        sql`b.shift_id IN (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      );
      const mt = this.d.schema.pos_cash_movements;
      const mv: Row[] = await tx
        .select()
        .from(mt)
        .where(and(eq(mt.business_id, ctx.businessId), isNull(mt.deleted_at)));
      const mine = new Set(ids);
      const movements = mv
        .filter((m) => mine.has(s(m['shift_id'])))
        .map((m) => ({
          kind: (s(m['kind']) === 'out' ? 'out' : 'in') as 'in' | 'out',
          amountPaise: big(m['amount_paise']),
        }));
      const float = shifts.reduce((t, x) => t + x.openingFloatPaise, 0n);
      return {
        z: buildZReport(
          rows.map((r) => this.billFacts(r)),
          movements,
          float,
        ),
        shifts: shifts.length,
        counters: new Set(shifts.map((x) => x.counterId)).size,
      };
    });
  }

  /** The items sold most over the last `days` days, for the counter's quick keys. */
  async topItems(
    ctx: Ctx,
    limit = 12,
    days = 60,
    today = new Date().toISOString().slice(0, 10),
  ): Promise<string[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT l.item_id, sum(l.qty_micros) AS q
            FROM document_lines l JOIN documents d ON d.id = l.document_id
            WHERE d.business_id = ${ctx.businessId} AND d.deleted_at IS NULL AND d.status = 'issued'
              AND d.type IN ('tax_invoice', 'bill_of_supply') AND d.date >= ${from}
              AND l.deleted_at IS NULL AND l.item_id IS NOT NULL
            GROUP BY l.item_id ORDER BY q DESC, l.item_id LIMIT ${limit}`,
      );
      return rows.map((r) => s(r['item_id']));
    });
  }

  /** Recent bills of a counter (to reprint or to return against), newest first. */
  async recentBills(ctx: Ctx, counterId: string, limit = 30): Promise<ShiftReport['bills']> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await this.factsIn(tx, ctx, sql`b.counter_id = ${counterId}`);
      return rows
        .slice(-limit)
        .reverse()
        .map((r) => ({
          id: s(r['id']),
          documentId: s(r['document_id']),
          number: s(r['number']),
          kind: (s(r['kind']) === 'return' ? 'return' : 'sale') as 'sale' | 'return',
          totalPaise: big(r['total_paise']),
          at: n(r['created_at']),
        }));
    });
  }
}

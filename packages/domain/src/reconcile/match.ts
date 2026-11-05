/**
 * The matching engine: GSTR-2B lines against purchase bills. Pure and deterministic: the same inputs
 * always give the same classes, in the same order. Work is grouped by supplier GSTIN, so 5,000 lines
 * against 5,000 bills is many small problems, not one large one.
 */
import { daysApart, normGstin, numberKey, numberParts, numbersAlike } from './normalise';
import {
  DEFAULT_RECON_OPTIONS,
  type BookBill,
  type Diff,
  type Entry2B,
  type Match,
  type ReconOptions,
} from './types';

const TAX_FIELDS = ['igst', 'cgst', 'sgst', 'cess'] as const;

const within = (a: number, b: number, o: ReconOptions): boolean => {
  const base = Math.max(Math.abs(a), Math.abs(b));
  const tol = Math.max(o.amountTolerancePaise, Math.floor((base * o.amountToleranceBp) / 10_000));
  return Math.abs(a - b) <= tol;
};

/** A credit note matches a purchase return; an invoice or debit note matches a purchase bill. */
const compatible = (e: Entry2B, b: BookBill): boolean =>
  e.docType === 'credit_note' ? b.type === 'purchase_return' : b.type === 'purchase_bill';

interface Compared {
  diffs: Diff[];
  delta: Match['delta'];
  cost: number;
}

function compare(e: Entry2B, b: BookBill, o: ReconOptions): Compared {
  const diffs: Diff[] = [];
  const delta = {
    taxable: e.taxable - b.taxable,
    igst: e.igst - b.igst,
    cgst: e.cgst - b.cgst,
    sgst: e.sgst - b.sgst,
    cess: e.cess - b.cess,
  };
  if (numberKey(e.number) !== numberKey(b.number)) diffs.push('number');
  if (Math.abs(daysApart(e.date, b.date)) > o.exactDateDays) diffs.push('date');
  if (!within(e.taxable, b.taxable, o)) diffs.push('taxable');
  for (const f of TAX_FIELDS) if (!within(e[f], b[f], o)) diffs.push(f);
  const cost =
    Math.abs(delta.taxable) +
    TAX_FIELDS.reduce((a, f) => a + Math.abs(delta[f]), 0) +
    Math.abs(daysApart(e.date, b.date)) * 100;
  return { diffs, delta, cost };
}

const byDateThenId = <T extends { date: string; id: string }>(a: T, b: T): number =>
  a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

/** Reconcile one set of 2B lines with one set of bills. Every input appears in exactly one result. */
export function reconcile(
  entries: readonly Entry2B[],
  books: readonly BookBill[],
  options: Partial<ReconOptions> = {},
): Match[] {
  const o: ReconOptions = { ...DEFAULT_RECON_OPTIONS, ...options };
  const out: Match[] = [];

  const entriesBy = new Map<string, Entry2B[]>();
  for (const e of [...entries].sort(byDateThenId)) {
    const k = normGstin(e.supplierGstin);
    (entriesBy.get(k) ?? entriesBy.set(k, []).get(k)!).push(e);
  }
  const booksBy = new Map<string, BookBill[]>();
  for (const b of [...books].sort(byDateThenId)) {
    const k = normGstin(b.supplierGstin);
    (booksBy.get(k) ?? booksBy.set(k, []).get(k)!).push(b);
  }

  const zero = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };

  for (const gstin of [...new Set([...entriesBy.keys(), ...booksBy.keys()])].sort()) {
    const es = entriesBy.get(gstin) ?? [];
    const bs = booksBy.get(gstin) ?? [];

    // a bill that repeats another (same supplier, same number) is a duplicate; the earliest is the real one
    const seen = new Map<string, BookBill>();
    const live: BookBill[] = [];
    for (const b of bs) {
      const k = `${b.type}|${numberKey(b.number)}`;
      const first = seen.get(k);
      if (first) {
        out.push({
          cls: 'duplicate_in_books',
          entryId: null,
          billId: b.id,
          diffs: [],
          fuzzy: false,
          delta: zero,
          duplicateOf: first.id,
        });
      } else {
        seen.set(k, b);
        live.push(b);
      }
    }

    const takenBill = new Set<string>();
    const takenEntry = new Set<string>();
    const pair = (e: Entry2B, b: BookBill, fuzzy: boolean) => {
      const c = compare(e, b, o);
      takenBill.add(b.id);
      takenEntry.add(e.id);
      out.push({
        cls: c.diffs.length === 0 ? 'matched' : 'matched_with_differences',
        entryId: e.id,
        billId: b.id,
        diffs: c.diffs,
        fuzzy: fuzzy || c.diffs.includes('number'),
        delta: c.delta,
        duplicateOf: null,
      });
    };

    // pass 1: the same number, and a date within the exact tolerance
    const liveByKey = new Map<string, BookBill[]>();
    for (const b of live) {
      const k = numberKey(b.number);
      (liveByKey.get(k) ?? liveByKey.set(k, []).get(k)!).push(b);
    }
    for (const e of es) {
      const cands = (liveByKey.get(numberKey(e.number)) ?? []).filter(
        (b) =>
          !takenBill.has(b.id) &&
          compatible(e, b) &&
          Math.abs(daysApart(e.date, b.date)) <= o.exactDateDays,
      );
      if (cands.length === 0) continue;
      const best = cands.reduce((a, b) => (compare(e, b, o).cost < compare(e, a, o).cost ? b : a));
      pair(e, best, false);
    }

    // pass 2: numbers that look alike, or the same number with a distant date, with amounts that agree.
    // Only bills whose number ends in the same digits can look alike, so those are the only candidates.
    const tailOf = (n: string): string => numberParts(n).tail || numberKey(n);
    const liveByTail = new Map<string, BookBill[]>();
    for (const b of live) {
      const k = tailOf(b.number);
      (liveByTail.get(k) ?? liveByTail.set(k, []).get(k)!).push(b);
    }
    for (const e of es) {
      if (takenEntry.has(e.id)) continue;
      let best: { b: BookBill; cost: number } | null = null;
      for (const b of liveByTail.get(tailOf(e.number)) ?? []) {
        if (takenBill.has(b.id) || !compatible(e, b)) continue;
        if (!numbersAlike(e.number, b.number)) continue;
        if (Math.abs(daysApart(e.date, b.date)) > o.fuzzyDateDays) continue;
        if (!within(e.taxable, b.taxable, o)) continue;
        const cost = compare(e, b, o).cost;
        if (!best || cost < best.cost) best = { b, cost };
      }
      if (best) pair(e, best.b, true);
    }

    for (const e of es) {
      if (takenEntry.has(e.id)) continue;
      out.push({
        cls: 'in_2b_not_in_books',
        entryId: e.id,
        billId: null,
        diffs: [],
        fuzzy: false,
        delta: { taxable: e.taxable, igst: e.igst, cgst: e.cgst, sgst: e.sgst, cess: e.cess },
        duplicateOf: null,
      });
    }
    for (const b of live) {
      if (takenBill.has(b.id)) continue;
      out.push({
        cls: 'in_books_not_in_2b',
        entryId: null,
        billId: b.id,
        diffs: [],
        fuzzy: false,
        delta: { taxable: -b.taxable, igst: -b.igst, cgst: -b.cgst, sgst: -b.sgst, cess: -b.cess },
        duplicateOf: null,
      });
    }
  }
  return out;
}

/**
 * A pair a person tied together by hand: taken as given, with the differences still reported so the
 * outcome (and the ITC adjustment) reflects them.
 */
export function pairMatch(e: Entry2B, b: BookBill, options: Partial<ReconOptions> = {}): Match {
  const o: ReconOptions = { ...DEFAULT_RECON_OPTIONS, ...options };
  const c = compare(e, b, o);
  return {
    cls: c.diffs.length === 0 ? 'matched' : 'matched_with_differences',
    entryId: e.id,
    billId: b.id,
    diffs: c.diffs,
    fuzzy: true,
    delta: c.delta,
    duplicateOf: null,
  };
}

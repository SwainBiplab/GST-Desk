/**
 * What a reconciliation means: the summary tiles, the adjustments that go to GSTR-3B table 4, and the
 * words that explain each class (Tier 0 templates; `explainWith` is the hook for a model-written
 * explanation later, prompt 48).
 */
import type { PeriodAdjustment } from '../gstr/types';

import type { BookBill, Diff, Entry2B, Match } from './types';

export interface Heads {
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}
const zero = (): Heads => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
const add = (a: Heads, b: Heads, sign: 1 | -1 = 1): Heads => ({
  igst: a.igst + sign * b.igst,
  cgst: a.cgst + sign * b.cgst,
  sgst: a.sgst + sign * b.sgst,
  cess: a.cess + sign * b.cess,
});
export const total = (h: Heads): number => h.igst + h.cgst + h.sgst + h.cess;

/** Credit notes and purchase returns reduce credit. */
const entrySign = (e: Entry2B): 1 | -1 => (e.docType === 'credit_note' ? -1 : 1);
/** Returns reduce credit, and a bill marked not eligible claims none. */
const billSign = (b: BookBill): 1 | -1 | 0 =>
  b.itcEligible === false ? 0 : b.type === 'purchase_return' ? -1 : 1;
const heads = (x: Heads): Heads => ({ igst: x.igst, cgst: x.cgst, sgst: x.sgst, cess: x.cess });

export interface Summary {
  /** Credit as the portal shows it, and as the books claim it. */
  per2b: Heads;
  perBooks: Heads;
  /** Credit that agrees (the smaller of the two) where the portal says it is available. */
  eligible: Heads;
  /** In the books, not yet in 2B: wait for the supplier to file. */
  toDefer: Heads;
  /** Claimed in the books and not allowed: duplicates, credit the portal says is not available, and any excess. */
  toReverse: Heads;
  /** In 2B with no bill in the books: credit that is there to claim once the bill is entered. */
  only2b: Heads;
  counts: Record<Match['cls'], number>;
}

export function summarise(
  matches: readonly Match[],
  entries: ReadonlyMap<string, Entry2B>,
  books: ReadonlyMap<string, BookBill>,
): Summary {
  const s: Summary = {
    per2b: zero(),
    perBooks: zero(),
    eligible: zero(),
    toDefer: zero(),
    toReverse: zero(),
    only2b: zero(),
    counts: {
      matched: 0,
      matched_with_differences: 0,
      in_2b_not_in_books: 0,
      in_books_not_in_2b: 0,
      duplicate_in_books: 0,
    },
  };
  for (const m of matches) {
    s.counts[m.cls] += 1;
    const e = m.entryId ? entries.get(m.entryId) : undefined;
    const b = m.billId ? books.get(m.billId) : undefined;
    const eh = e
      ? {
          igst: e.igst * entrySign(e),
          cgst: e.cgst * entrySign(e),
          sgst: e.sgst * entrySign(e),
          cess: e.cess * entrySign(e),
        }
      : null;
    const bh = b
      ? {
          igst: b.igst * billSign(b),
          cgst: b.cgst * billSign(b),
          sgst: b.sgst * billSign(b),
          cess: b.cess * billSign(b),
        }
      : null;
    if (eh) s.per2b = add(s.per2b, eh);
    if (bh) s.perBooks = add(s.perBooks, bh);
    switch (m.cls) {
      case 'matched':
      case 'matched_with_differences': {
        if (!eh || !bh) break;
        if (e!.itcAvailable === 'N') {
          s.toReverse = add(s.toReverse, bh);
        } else {
          for (const k of ['igst', 'cgst', 'sgst', 'cess'] as const) {
            const keep = Math.abs(eh[k]) < Math.abs(bh[k]) ? eh[k] : bh[k];
            s.eligible[k] += keep;
            // claimed more than the portal shows
            if (Math.abs(bh[k]) > Math.abs(eh[k])) s.toReverse[k] += bh[k] - eh[k];
          }
        }
        break;
      }
      case 'in_books_not_in_2b':
        if (bh) s.toDefer = add(s.toDefer, bh);
        break;
      case 'duplicate_in_books':
        if (bh) s.toReverse = add(s.toReverse, bh);
        break;
      case 'in_2b_not_in_books':
        if (eh && e!.itcAvailable !== 'N') s.only2b = add(s.only2b, eh);
        break;
    }
  }
  return s;
}

/** The changes to GSTR-3B table 4 that follow from a reconciliation, one row per reason, never zero rows. */
export function adjustmentsFor(
  matches: readonly Match[],
  entries: ReadonlyMap<string, Entry2B>,
  books: ReadonlyMap<string, BookBill>,
): PeriodAdjustment[] {
  const defer = zero();
  const duplicate = zero();
  const notAvailable = zero();
  const excess = zero();
  for (const m of matches) {
    const b = m.billId ? books.get(m.billId) : undefined;
    const e = m.entryId ? entries.get(m.entryId) : undefined;
    const bh = b
      ? {
          igst: b.igst * billSign(b),
          cgst: b.cgst * billSign(b),
          sgst: b.sgst * billSign(b),
          cess: b.cess * billSign(b),
        }
      : null;
    if (m.cls === 'in_books_not_in_2b' && bh) Object.assign(defer, add(defer, bh));
    else if (m.cls === 'duplicate_in_books' && bh) Object.assign(duplicate, add(duplicate, bh));
    else if ((m.cls === 'matched' || m.cls === 'matched_with_differences') && e && bh) {
      const eh = {
        igst: e.igst * entrySign(e),
        cgst: e.cgst * entrySign(e),
        sgst: e.sgst * entrySign(e),
        cess: e.cess * entrySign(e),
      };
      if (e.itcAvailable === 'N') Object.assign(notAvailable, add(notAvailable, bh));
      else
        for (const k of ['igst', 'cgst', 'sgst', 'cess'] as const)
          if (Math.abs(bh[k]) > Math.abs(eh[k])) excess[k] += bh[k] - eh[k];
    }
  }
  const out: PeriodAdjustment[] = [];
  const push = (field: string, h: Heads, sign: 1 | -1, reason: string) => {
    if (total(h) === 0 && Object.values(h).every((v) => v === 0)) return;
    out.push({
      field,
      iamt: sign * h.igst,
      camt: sign * h.cgst,
      samt: sign * h.sgst,
      csamt: sign * h.cess,
      reason,
    });
  };
  push('itc.availableOther', defer, -1, 'GSTR-2B: not shown by the supplier yet, so not claimed');
  push('itc.availableOther', duplicate, -1, 'GSTR-2B: a duplicate bill in the books');
  push(
    'itc.availableOther',
    notAvailable,
    -1,
    'GSTR-2B: the portal says this credit is not available',
  );
  push(
    'itc.ineligibleOther',
    notAvailable,
    1,
    'GSTR-2B: the portal says this credit is not available',
  );
  push(
    'itc.availableOther',
    excess,
    -1,
    'GSTR-2B: the bill claims more tax than the supplier reported',
  );
  return out;
}

/* ------------------------------------------------------------------ explanations */

export interface Explanation {
  /** Catalogue key suffix under `gst.recon.explain`. */
  key: 'matched' | 'differs' | 'only2b' | 'onlyBooks' | 'duplicate' | 'notAvailable';
  params: Record<string, string | number>;
}

const FIELD_ORDER: Diff[] = ['number', 'date', 'taxable', 'igst', 'cgst', 'sgst', 'cess'];

/** Tier 0 explanation of one result: a key and parameters the screen turns into words in the person's language. */
export function explain(m: Match, e?: Entry2B, b?: BookBill): Explanation {
  switch (m.cls) {
    case 'matched':
      return {
        key: e?.itcAvailable === 'N' ? 'notAvailable' : 'matched',
        params: { reason: e?.reason ?? '' },
      };
    case 'matched_with_differences':
      return {
        key: 'differs',
        params: {
          fields: FIELD_ORDER.filter((f) => m.diffs.includes(f)).join(','),
          other: e?.number ?? '',
          mine: b?.number ?? '',
        },
      };
    case 'in_2b_not_in_books':
      return { key: 'only2b', params: { supplier: e?.supplierName || e?.supplierGstin || '' } };
    case 'in_books_not_in_2b':
      return { key: 'onlyBooks', params: { supplier: b?.supplierGstin ?? '' } };
    case 'duplicate_in_books':
      return { key: 'duplicate', params: { number: b?.number ?? '' } };
  }
}

/** The hook for a richer explanation (prompt 48): when given, it is tried first and Tier 0 is the fallback. */
export async function explainWith(
  m: Match,
  e: Entry2B | undefined,
  b: BookBill | undefined,
  tier2?: (m: Match, e?: Entry2B, b?: BookBill) => Promise<string | null>,
): Promise<{ text: string | null; fallback: Explanation }> {
  const fallback = explain(m, e, b);
  if (!tier2) return { text: null, fallback };
  try {
    return { text: await tier2(m, e, b), fallback };
  } catch {
    return { text: null, fallback };
  }
}

export { heads };

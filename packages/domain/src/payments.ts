/**
 * Payments, allocations and party credit (prompt 16). Pure functions: the repository stores what these
 * decide. Amounts are integer paise in `bigint`; nothing here reads the clock.
 */
import { BP, divRound, max, min } from './money';
import { FIFTY_LAKH, TCS_206C1H_SUNSET } from './tax/document';

/** A round-off difference up to this many paise can be written off instead of left open. */
export const WRITE_OFF_MAX_PAISE = 99n;

/* ------------------------------------------------------------------ document settlement */

export interface Settlement {
  totalPaise: bigint;
  /** Money allocated from payments. */
  paidPaise: bigint;
  /** Credit (advances, credit notes) applied to it. */
  creditAppliedPaise: bigint;
  /** Small differences written off. */
  writtenOffPaise: bigint;
}

/** What is still owed on a document. Negative means more was settled than the total (overpaid). */
export const balanceOfDocument = (s: Settlement): bigint =>
  s.totalPaise - s.paidPaise - s.creditAppliedPaise - s.writtenOffPaise;

export type PayStatus = 'unpaid' | 'partial' | 'paid' | 'overpaid';

/** Derived, never stored: from the total and what has been settled against it. */
export function payStatus(s: Settlement): PayStatus {
  const balance = balanceOfDocument(s);
  if (balance < 0n) return 'overpaid';
  if (balance === 0n) return s.totalPaise === 0n ? 'unpaid' : 'paid';
  return s.paidPaise + s.creditAppliedPaise + s.writtenOffPaise > 0n ? 'partial' : 'unpaid';
}

const DAY = 86_400_000;
const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
};

/** Whole days past the due date while something is still owed; 0 when not overdue. */
export function overdueDays(dueDate: string | null, today: string, balancePaise: bigint): number {
  if (!dueDate || balancePaise <= 0n) return 0;
  return Math.max(0, dayNumber(today) - dayNumber(dueDate));
}

/* ------------------------------------------------------------------ allocation */

export interface OpenDocument {
  id: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  balancePaise: bigint;
}

export interface Allocation {
  documentId: string;
  amountPaise: bigint;
}

/**
 * Oldest first: by due date (or date when there is none), then date, then number. Fills each document's
 * balance in turn and returns what is left over.
 */
export function autoAllocate(
  docs: readonly OpenDocument[],
  amountPaise: bigint,
): { allocations: Allocation[]; remainderPaise: bigint } {
  const order = [...docs]
    .filter((d) => d.balancePaise > 0n)
    .sort(
      (a, b) =>
        (a.dueDate ?? a.date).localeCompare(b.dueDate ?? b.date) ||
        a.date.localeCompare(b.date) ||
        (a.number ?? '').localeCompare(b.number ?? '', 'en', { numeric: true }) ||
        a.id.localeCompare(b.id),
    );
  let left = amountPaise > 0n ? amountPaise : 0n;
  const allocations: Allocation[] = [];
  for (const d of order) {
    if (left === 0n) break;
    const take = min(left, d.balancePaise);
    allocations.push({ documentId: d.id, amountPaise: take });
    left -= take;
  }
  return { allocations, remainderPaise: left };
}

export interface AllocationRequest extends Allocation {
  /** Round-off difference to write off on the same document (0 to 99 paise). */
  writeOffPaise?: bigint;
}

/**
 * Everything wrong with a set of allocations for a payment: more than the payment, more than a
 * document's balance, non-positive amounts, write-offs that are not small round-off differences.
 * `consideration` is the payment less any TCS collected on it (TCS never settles a document).
 */
export function validateAllocations(input: {
  considerationPaise: bigint;
  allocations: readonly AllocationRequest[];
  balances: ReadonlyMap<string, bigint>;
}): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  let total = 0n;
  for (const a of input.allocations) {
    if (seen.has(a.documentId)) errors.push(`document ${a.documentId} is allocated twice`);
    seen.add(a.documentId);
    const balance = input.balances.get(a.documentId);
    if (balance === undefined) {
      errors.push(`document ${a.documentId} is not open for this party`);
      continue;
    }
    const wo = a.writeOffPaise ?? 0n;
    if (a.amountPaise < 0n || wo < 0n) errors.push('amounts cannot be negative');
    if (a.amountPaise === 0n && wo === 0n) errors.push('an allocation needs an amount');
    if (a.amountPaise + wo > balance)
      errors.push(`allocation to ${a.documentId} is more than what is owed on it`);
    if (wo > 0n) {
      if (wo > WRITE_OFF_MAX_PAISE)
        errors.push(`only differences up to ${WRITE_OFF_MAX_PAISE} paise can be written off`);
      if (a.amountPaise + wo !== balance)
        errors.push('a write-off must close the document: nothing may remain after it');
    }
    total += a.amountPaise;
  }
  if (total > input.considerationPaise)
    errors.push('allocations are more than the amount received');
  return errors;
}

/* ------------------------------------------------------------------ TCS on receipt */

export interface TcsReceiptInput {
  /** What the customer paid towards documents, before TCS. */
  considerationPaise: bigint;
  /** Consideration already received from this party in the financial year. */
  cumulativeBeforePaise: bigint;
  rateBp: number;
  /** ISO date of the receipt. */
  date: string;
  thresholdPaise?: bigint;
  /** 206C(1H) stopped applying to receipts on or after this date. */
  sunsetDate?: string;
  /** The buyer deducts TDS u/s 194Q, so the seller collects no TCS. */
  buyerDeductsTds?: boolean;
}

/**
 * TCS u/s 206C(1H) on a receipt: on the part of the consideration above Rs 50 lakh cumulative in the
 * year, including the part of this receipt that crosses it. Zero for receipts on or after 1 Apr 2025
 * (Finance Act 2025 omitted s.206C(1H)).
 */
export function tcsOnReceipt(i: TcsReceiptInput): { tcsPaise: bigint; note: string } {
  const sunset = i.sunsetDate ?? TCS_206C1H_SUNSET;
  if (i.buyerDeductsTds)
    return { tcsPaise: 0n, note: 'The buyer deducts TDS u/s 194Q, so no TCS is collected.' };
  if (i.date >= sunset)
    return { tcsPaise: 0n, note: `TCS u/s 206C(1H) does not apply to receipts from ${sunset}.` };
  const threshold = i.thresholdPaise ?? FIFTY_LAKH;
  const over = max(
    0n,
    min(i.considerationPaise, i.cumulativeBeforePaise + i.considerationPaise - threshold),
  );
  if (over === 0n) return { tcsPaise: 0n, note: 'Receipts stay within the Rs 50 lakh threshold.' };
  const tcs = divRound(over * BigInt(i.rateBp), BP);
  return { tcsPaise: tcs, note: `TCS on ${over} paise above the threshold at ${i.rateBp / 100}%.` };
}

/* ------------------------------------------------------------------ party credit */

export interface CreditSource {
  /** `payment` for an advance (unallocated money received or paid), `document` for a credit note. */
  kind: 'payment' | 'document';
  id: string;
  date: string;
  /** Receipt voucher or credit note number, for display. */
  label: string;
  remainingPaise: bigint;
}

/** What is left of a credit source: its amount less everything allocated or applied from it. */
export const creditRemaining = (totalPaise: bigint, usedPaise: bigint): bigint =>
  max(0n, totalPaise - usedPaise);

/**
 * Use credit against one document, oldest source first, never more than the document's balance or
 * a source's remainder. Returns one allocation per source used.
 */
export function planCreditApplication(
  sources: readonly CreditSource[],
  balancePaise: bigint,
  limitPaise?: bigint,
): { source: CreditSource; amountPaise: bigint }[] {
  let left = min(balancePaise, limitPaise ?? balancePaise);
  const out: { source: CreditSource; amountPaise: bigint }[] = [];
  for (const s of [...sources].sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  )) {
    if (left <= 0n) break;
    if (s.remainingPaise <= 0n) continue;
    const take = min(left, s.remainingPaise);
    out.push({ source: s, amountPaise: take });
    left -= take;
  }
  return out;
}

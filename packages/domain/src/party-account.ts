/**
 * A party's account: statement, balance and ageing, computed from documents and payments (never stored).
 *
 * Sign convention: a positive balance means the party owes us; negative means we owe the party.
 * Customers' invoices push the balance up, their payments pull it down; for suppliers it is the reverse.
 */
import { min, sum } from './money';
import type { DocumentType } from './turnover';

export interface AccountDoc {
  id: string;
  number: string | null;
  type: DocumentType;
  date: string;
  dueDate: string | null;
  totalPaise: bigint;
}

export interface AccountPayment {
  id: string;
  date: string;
  direction: 'received' | 'made';
  amountPaise: bigint;
  mode: string;
  reference: string | null;
}

export interface PartyAccountInput {
  openingPaise: bigint;
  /** When the opening balance applies. Null means "before everything". */
  openingDate: string | null;
  /** Issued documents only. */
  docs: AccountDoc[];
  /** Cleared payments only. */
  payments: AccountPayment[];
}

/** How an issued document moves the balance: +1 raises what they owe us, -1 lowers it, 0 does not post. */
export function docEffect(type: DocumentType): 1 | -1 | 0 {
  switch (type) {
    case 'tax_invoice':
    case 'bill_of_supply':
    case 'debit_note':
    case 'purchase_return':
      return 1;
    case 'credit_note':
    case 'purchase_bill':
    case 'expense':
      return -1;
    default:
      return 0;
  }
}

const paymentEffect = (p: AccountPayment): bigint =>
  p.direction === 'received' ? -p.amountPaise : p.amountPaise;

/** Net balance: opening + documents - payments received + payments made. */
export function balanceOf(a: PartyAccountInput): bigint {
  let b = a.openingPaise;
  for (const d of a.docs) b += BigInt(docEffect(d.type)) * d.totalPaise;
  for (const p of a.payments) b += paymentEffect(p);
  return b;
}

export interface StatementLine {
  id: string;
  date: string;
  kind: 'opening' | 'document' | 'payment';
  /** Document number or payment reference. */
  ref: string;
  description: string;
  /** Increases what they owe us. */
  debitPaise: bigint;
  /** Decreases what they owe us. */
  creditPaise: bigint;
  balancePaise: bigint;
}

export interface Statement {
  /** Balance before the first line of the range. */
  openingBalancePaise: bigint;
  lines: StatementLine[];
  closingBalancePaise: bigint;
}

const KIND_ORDER = { opening: 0, document: 1, payment: 2 } as const;

function entries(a: PartyAccountInput): Omit<StatementLine, 'balancePaise'>[] {
  const out: Omit<StatementLine, 'balancePaise'>[] = [];
  if (a.openingPaise !== 0n) {
    out.push({
      id: 'opening',
      date: a.openingDate ?? '0000-01-01',
      kind: 'opening',
      ref: '',
      description: 'Opening balance',
      debitPaise: a.openingPaise > 0n ? a.openingPaise : 0n,
      creditPaise: a.openingPaise < 0n ? -a.openingPaise : 0n,
    });
  }
  for (const d of a.docs) {
    const e = docEffect(d.type);
    if (e === 0) continue;
    out.push({
      id: d.id,
      date: d.date,
      kind: 'document',
      ref: d.number ?? '',
      description: d.type.replace(/_/g, ' '),
      debitPaise: e > 0 ? d.totalPaise : 0n,
      creditPaise: e < 0 ? d.totalPaise : 0n,
    });
  }
  for (const p of a.payments) {
    out.push({
      id: p.id,
      date: p.date,
      kind: 'payment',
      ref: p.reference ?? '',
      description: `${p.direction === 'received' ? 'Payment received' : 'Payment made'} (${p.mode})`,
      debitPaise: p.direction === 'made' ? p.amountPaise : 0n,
      creditPaise: p.direction === 'received' ? p.amountPaise : 0n,
    });
  }
  return out.sort(
    (x, y) =>
      x.date.localeCompare(y.date) ||
      KIND_ORDER[x.kind] - KIND_ORDER[y.kind] ||
      x.ref.localeCompare(y.ref) ||
      x.id.localeCompare(y.id),
  );
}

/**
 * Statement with a running balance. With a range, lines before `from` fold into the opening balance
 * and lines after `to` are left out. `from` and `to` are inclusive ISO dates.
 */
export function buildStatement(
  a: PartyAccountInput,
  range: { from?: string; to?: string } = {},
): Statement {
  let running = 0n;
  let opening = 0n;
  const lines: StatementLine[] = [];
  for (const e of entries(a)) {
    const delta = e.debitPaise - e.creditPaise;
    if (range.from !== undefined && e.date < range.from) {
      opening += delta;
      running += delta;
      continue;
    }
    if (range.to !== undefined && e.date > range.to) continue;
    running += delta;
    lines.push({ ...e, balancePaise: running });
  }
  return { openingBalancePaise: opening, lines, closingBalancePaise: running };
}

/* ------------------------------------------------------------------ ageing */

export type AgeBucket = 'current' | 'd0_30' | 'd31_60' | 'd61_90' | 'd90plus';

export interface Ageing {
  /** `receivable`: they owe us. `payable`: we owe them. */
  direction: 'receivable' | 'payable';
  current: bigint;
  d0_30: bigint;
  d31_60: bigint;
  d61_90: bigint;
  d90plus: bigint;
  /** Sum of the five buckets. Equals the absolute balance. */
  totalDuePaise: bigint;
  /** Everything past its due date (the four overdue buckets). */
  overduePaise: bigint;
}

/** Whole days from `from` to `to` (both ISO dates); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const parse = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/**
 * Bucket by days past the due date: not yet due is `current`; due today to 30 days late is `d0_30`;
 * then 31-60, 61-90 and 91 or more.
 */
export function ageBucket(daysOverdue: number): AgeBucket {
  if (daysOverdue < 0) return 'current';
  if (daysOverdue <= 30) return 'd0_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90plus';
}

/**
 * Age what is owed. Money in the direction of the balance (charges) is aged by due date; money the other
 * way (payments, credit notes, opposite-side documents) is applied to the oldest charges first.
 * If credits outweigh charges the balance flips side (an overpayment becomes a payable), so nothing is left over.
 */
export function buildAgeing(a: PartyAccountInput, today: string): Ageing {
  const balance = balanceOf(a);
  const direction = balance >= 0n ? 'receivable' : 'payable';
  const sign = direction === 'receivable' ? 1n : -1n;

  const charges: { due: string; amount: bigint }[] = [];
  let credit = 0n;
  const add = (due: string, signed: bigint) => {
    const oriented = signed * sign;
    if (oriented > 0n) charges.push({ due, amount: oriented });
    else credit += -oriented;
  };
  if (a.openingPaise !== 0n) add(a.openingDate ?? '0000-01-01', a.openingPaise);
  for (const d of a.docs) {
    const e = docEffect(d.type);
    if (e !== 0) add(d.dueDate ?? d.date, BigInt(e) * d.totalPaise);
  }
  for (const p of a.payments)
    credit += p.direction === 'received' ? sign * p.amountPaise : -sign * p.amountPaise;
  // a payment in the "wrong" direction for this side is a charge, not a credit
  if (credit < 0n) {
    charges.push({ due: today, amount: -credit });
    credit = 0n;
  }

  charges.sort((x, y) => x.due.localeCompare(y.due));
  const buckets: Record<AgeBucket, bigint> = {
    current: 0n,
    d0_30: 0n,
    d31_60: 0n,
    d61_90: 0n,
    d90plus: 0n,
  };
  for (const c of charges) {
    const used = min(c.amount, credit);
    credit -= used;
    const left = c.amount - used;
    if (left > 0n) buckets[ageBucket(daysBetween(c.due, today))] += left;
  }
  const total = sum(Object.values(buckets));
  return {
    direction,
    ...buckets,
    totalDuePaise: total,
    overduePaise: total - buckets.current,
  };
}

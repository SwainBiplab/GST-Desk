/**
 * Posting rules: turn an issued document or a payment into balanced ledger lines.
 * Accounts are referenced by key; the caller maps keys to ledger_accounts rows.
 * Every posting is checked to balance to zero and throws otherwise.
 */
import { sum } from '../money';
import type { DocumentStatus, DocumentType } from '../turnover';

export type TaxHead = 'Cgst' | 'Sgst' | 'Utgst' | 'Igst' | 'Cess';

export type AccountKey =
  | 'cash'
  | 'bank'
  | 'receivables'
  | 'payables'
  | 'sales'
  | 'purchases'
  | 'expenses'
  | 'roundOff'
  | 'openingEquity'
  | 'tcsPayable'
  | 'adjustments'
  | `output${TaxHead}`
  | `input${TaxHead}`;

export interface LedgerLine {
  account: AccountKey;
  debitPaise: bigint;
  creditPaise: bigint;
  narration: string;
}

export class PostingError extends Error {
  override name = 'PostingError';
}

export class LedgerImbalanceError extends Error {
  override name = 'LedgerImbalanceError';
}

export interface PostableDocument {
  type: DocumentType;
  status: DocumentStatus;
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  utgstPaise: bigint;
  igstPaise: bigint;
  cessPaise: bigint;
  tcsPaise: bigint;
  roundOffPaise: bigint;
  /** Invoice total as stored (taxable + tax charged + TCS + round-off). */
  totalPaise: bigint;
  /** Tax is payable by the recipient: not in the total, self-assessed on both sides. */
  reverseCharge?: boolean;
}

const HEADS: [TaxHead, keyof PostableDocument][] = [
  ['Cgst', 'cgstPaise'],
  ['Sgst', 'sgstPaise'],
  ['Utgst', 'utgstPaise'],
  ['Igst', 'igstPaise'],
  ['Cess', 'cessPaise'],
];

export function assertBalanced(lines: readonly LedgerLine[]): void {
  const dr = sum(lines.map((l) => l.debitPaise));
  const cr = sum(lines.map((l) => l.creditPaise));
  if (dr !== cr) throw new LedgerImbalanceError(`debits ${dr} != credits ${cr}`);
}

const NON_POSTING: ReadonlySet<DocumentType> = new Set([
  'proforma',
  'quotation',
  'delivery_challan',
  'receipt_voucher',
]);

type Side = 'dr' | 'cr';

/** Post an issued document. Returns `[]` for types that do not touch the books. */
export function postDocument(doc: PostableDocument): LedgerLine[] {
  if (NON_POSTING.has(doc.type)) return [];
  if (doc.status !== 'issued')
    throw new PostingError(`only issued documents post to the ledger (status: ${doc.status})`);

  const lines: LedgerLine[] = [];
  const add = (account: AccountKey, side: Side, amount: bigint, narration: string) => {
    if (amount === 0n) return;
    if (amount < 0n) throw new PostingError(`negative posting amount for ${account}`);
    lines.push({
      account,
      debitPaise: side === 'dr' ? amount : 0n,
      creditPaise: side === 'cr' ? amount : 0n,
      narration,
    });
  };

  const sale =
    doc.type === 'tax_invoice' || doc.type === 'bill_of_supply' || doc.type === 'debit_note';
  const saleReturn = doc.type === 'credit_note';
  const purchase = doc.type === 'purchase_bill' || doc.type === 'expense';
  const purchaseReturn = doc.type === 'purchase_return';
  if (!sale && !saleReturn && !purchase && !purchaseReturn) {
    throw new PostingError(`no posting rule for ${doc.type}`);
  }

  const outward = sale || saleReturn;
  // outward: counterparty is a receivable; inward: a payable
  const party: AccountKey = outward ? 'receivables' : 'payables';
  const base: AccountKey = outward ? 'sales' : doc.type === 'expense' ? 'expenses' : 'purchases';
  // sale credits revenue and tax and debits the party; purchase is the opposite; returns flip both
  const flip = saleReturn || purchaseReturn;
  const baseSide: Side = outward ? (flip ? 'dr' : 'cr') : flip ? 'cr' : 'dr';
  const partySide: Side = baseSide === 'cr' ? 'dr' : 'cr';

  const taxAccount = (h: TaxHead): AccountKey => (outward ? `output${h}` : `input${h}`);
  const charged = !doc.reverseCharge;

  add(base, baseSide, doc.taxablePaise, `${doc.type} value`);
  for (const [head, key] of HEADS) {
    const amount = doc[key] as bigint;
    if (charged) add(taxAccount(head), baseSide, amount, `${head.toUpperCase()} on ${doc.type}`);
  }
  add('tcsPayable', baseSide, doc.tcsPaise, 'TCS collected');

  // round-off sits on the base side when positive (adds to the party balance)
  const ro = doc.roundOffPaise;
  if (ro > 0n) add('roundOff', baseSide, ro, 'round-off');
  else if (ro < 0n) add('roundOff', partySide, -ro, 'round-off');

  add(party, partySide, doc.totalPaise, `${doc.type} total`);

  // reverse charge: recipient self-assesses, input credit equals output liability
  if (doc.reverseCharge && !outward) {
    for (const [head, key] of HEADS) {
      const amount = doc[key] as bigint;
      add(`input${head}`, flip ? 'cr' : 'dr', amount, `RCM input ${head.toUpperCase()}`);
      add(`output${head}`, flip ? 'dr' : 'cr', amount, `RCM liability ${head.toUpperCase()}`);
    }
  }

  assertBalanced(lines);
  return lines;
}

export interface PostablePayment {
  direction: 'received' | 'made';
  mode: 'cash' | 'upi' | 'card' | 'bank' | 'cheque' | 'other' | 'adjustment';
  /** Everything received or paid, including any TCS collected on a receipt. */
  amountPaise: bigint;
  /** TCS u/s 206C(1H) collected with a receipt: part of the amount, a liability, not a settlement. */
  tcsPaise?: bigint;
}

/**
 * Receipt from a customer or payment to a supplier. Cash goes to cash, an adjustment (a set-off or
 * discount, no money moves) to the adjustments account, everything else to bank. TCS collected on a
 * receipt is credited to TCS payable, so only the rest settles the customer's account.
 */
export function postPayment(p: PostablePayment): LedgerLine[] {
  if (p.amountPaise <= 0n) throw new PostingError('payment amount must be positive');
  const tcs = p.tcsPaise ?? 0n;
  if (tcs < 0n || tcs >= p.amountPaise)
    throw new PostingError('TCS must be positive and less than the amount received');
  if (tcs > 0n && p.direction !== 'received')
    throw new PostingError('TCS is collected on receipts only');
  const money: AccountKey =
    p.mode === 'cash' ? 'cash' : p.mode === 'adjustment' ? 'adjustments' : 'bank';
  const lines: LedgerLine[] =
    p.direction === 'received'
      ? [
          { account: money, debitPaise: p.amountPaise, creditPaise: 0n, narration: 'receipt' },
          {
            account: 'receivables',
            debitPaise: 0n,
            creditPaise: p.amountPaise - tcs,
            narration: 'receipt',
          },
          ...(tcs > 0n
            ? [
                {
                  account: 'tcsPayable' as AccountKey,
                  debitPaise: 0n,
                  creditPaise: tcs,
                  narration: 'TCS collected on receipt',
                },
              ]
            : []),
        ]
      : [
          { account: 'payables', debitPaise: p.amountPaise, creditPaise: 0n, narration: 'payment' },
          { account: money, debitPaise: 0n, creditPaise: p.amountPaise, narration: 'payment' },
        ];
  assertBalanced(lines);
  return lines;
}

/**
 * A small round-off difference written off against a document: the customer owes (or we owe) a few
 * paise less. Receivables are credited and round-off debited; for a supplier bill the sides swap.
 */
export function postWriteOff(direction: 'received' | 'made', amountPaise: bigint): LedgerLine[] {
  if (amountPaise <= 0n) throw new PostingError('write-off must be positive');
  const lines: LedgerLine[] =
    direction === 'received'
      ? [
          { account: 'roundOff', debitPaise: amountPaise, creditPaise: 0n, narration: 'write-off' },
          {
            account: 'receivables',
            debitPaise: 0n,
            creditPaise: amountPaise,
            narration: 'write-off',
          },
        ]
      : [
          { account: 'payables', debitPaise: amountPaise, creditPaise: 0n, narration: 'write-off' },
          { account: 'roundOff', debitPaise: 0n, creditPaise: amountPaise, narration: 'write-off' },
        ];
  assertBalanced(lines);
  return lines;
}

/**
 * Opening balance of a party. Positive means the party owes us (debit receivables); negative means we owe
 * them (credit payables). The other side goes to opening balance equity, so the books still balance.
 */
export function postOpeningBalance(openingPaise: bigint, party = ''): LedgerLine[] {
  if (openingPaise === 0n) return [];
  const narration = `Opening balance${party ? `: ${party}` : ''}`;
  const amount = openingPaise > 0n ? openingPaise : -openingPaise;
  const lines: LedgerLine[] =
    openingPaise > 0n
      ? [
          { account: 'receivables', debitPaise: amount, creditPaise: 0n, narration },
          { account: 'openingEquity', debitPaise: 0n, creditPaise: amount, narration },
        ]
      : [
          { account: 'openingEquity', debitPaise: amount, creditPaise: 0n, narration },
          { account: 'payables', debitPaise: 0n, creditPaise: amount, narration },
        ];
  assertBalanced(lines);
  return lines;
}

const flip = (lines: LedgerLine[]): LedgerLine[] =>
  lines.map((l) => ({
    ...l,
    debitPaise: l.creditPaise,
    creditPaise: l.debitPaise,
    narration: `${l.narration} (adjusted)`,
  }));

/**
 * Entries for changing a party's opening balance from `oldPaise` to `newPaise`. Moving within one side
 * (they owe us more or less) posts only the difference; crossing from "they owe us" to "we owe them" (or
 * to or from zero) reverses the old postings and posts the new ones, so receivables and payables stay right.
 */
export function openingBalanceChange(oldPaise: bigint, newPaise: bigint, party = ''): LedgerLine[] {
  if (oldPaise === newPaise) return [];
  if (oldPaise >= 0n && newPaise >= 0n) {
    const delta = newPaise - oldPaise;
    return delta > 0n ? postOpeningBalance(delta, party) : flip(postOpeningBalance(-delta, party));
  }
  if (oldPaise <= 0n && newPaise <= 0n) {
    // amounts we owe: more owed = more payable
    const delta = oldPaise - newPaise; // positive when we owe more
    return delta > 0n ? postOpeningBalance(-delta, party) : flip(postOpeningBalance(delta, party));
  }
  return [...flip(postOpeningBalance(oldPaise, party)), ...postOpeningBalance(newPaise, party)];
}

/**
 * Typed-argument grammar for the command bar: "pay 5000 to Sharma", "received 1.5 lakh from Iyer",
 * "new invoice for Das", "go parties". Tier 0 only: no model. Unparsed text falls through to search
 * and then to the natural-language stub.
 *
 *   payment := (pay|paid|send) AMOUNT (to) PARTY | (receive|received|rcv|got) AMOUNT (from) PARTY
 *   new     := (new|create|add) DOC [for PARTY]
 *   go      := (go|open|goto) [to] PAGE
 *   AMOUNT  := [₹|rs|inr] NUMBER [k|lakh|lac|l|cr|crore|m|million]
 */
import { rupees } from '@gst/domain';

export type DocKind = 'invoice' | 'bill' | 'quotation' | 'purchase' | 'credit_note' | 'expense';

export type Intent =
  | { kind: 'payment'; direction: 'made' | 'received'; amountPaise: bigint; party: string }
  | { kind: 'new'; doc: DocKind; party?: string }
  | { kind: 'go'; page: string };

const MULTIPLIERS: Record<string, bigint> = {
  k: 1_000n,
  thousand: 1_000n,
  l: 100_000n,
  lac: 100_000n,
  lakh: 100_000n,
  lakhs: 100_000n,
  m: 1_000_000n,
  million: 1_000_000n,
  cr: 10_000_000n,
  crore: 10_000_000n,
  crores: 10_000_000n,
};

/** "5,000" / "₹1.5 lakh" / "2k" -> integer paise, or null. */
export function parseAmount(text: string): bigint | null {
  const m = /^\s*(?:₹|rs\.?|inr)?\s*([\d,]*\.?\d+)\s*([a-z]+)?\s*$/i.exec(text);
  if (!m) return null;
  const mult = m[2] ? MULTIPLIERS[m[2].toLowerCase()] : 1n;
  if (!mult) return null;
  const base = rupees(m[1]!.replace(/,/g, ''));
  return base * mult;
}

const DOCS: Record<string, DocKind> = {
  invoice: 'invoice',
  inv: 'invoice',
  bill: 'bill',
  sale: 'invoice',
  quote: 'quotation',
  quotation: 'quotation',
  purchase: 'purchase',
  po: 'purchase',
  credit: 'credit_note',
  'credit note': 'credit_note',
  expense: 'expense',
};

export const PAGES = [
  'dashboard',
  'sell',
  'parties',
  'items',
  'documents',
  'payments',
  'reports',
  'inbox',
  'settings',
] as const;

const PAGE_ALIASES: Record<string, (typeof PAGES)[number]> = {
  home: 'dashboard',
  dash: 'dashboard',
  customers: 'parties',
  suppliers: 'parties',
  party: 'parties',
  products: 'items',
  stock: 'items',
  invoices: 'documents',
  docs: 'documents',
  money: 'payments',
  payment: 'payments',
  report: 'reports',
  gst: 'reports',
  review: 'inbox',
};

/** Parse a command line into a typed intent, or null when it is not one. */
export function parseCommand(input: string): Intent | null {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) return null;

  let m = /^(pay|paid|send)\s+(.+?)\s+to\s+(.+)$/i.exec(text);
  if (m) {
    const amount = parseAmount(m[2]!);
    if (amount && amount > 0n)
      return { kind: 'payment', direction: 'made', amountPaise: amount, party: m[3]! };
    return null;
  }
  m = /^(receive|received|rcv|got|collect)\s+(.+?)\s+from\s+(.+)$/i.exec(text);
  if (m) {
    const amount = parseAmount(m[2]!);
    if (amount && amount > 0n)
      return { kind: 'payment', direction: 'received', amountPaise: amount, party: m[3]! };
    return null;
  }

  m = /^(?:new|create|add)\s+([a-z ]+?)(?:\s+for\s+(.+))?$/i.exec(text);
  if (m) {
    const doc = DOCS[m[1]!.toLowerCase().trim()];
    if (doc) return { kind: 'new', doc, ...(m[2] ? { party: m[2] } : {}) };
    return null;
  }

  m = /^(?:go|open|goto)\s+(?:to\s+)?([a-z]+)$/i.exec(text);
  if (m) {
    const word = m[1]!.toLowerCase();
    const page = (PAGES as readonly string[]).includes(word) ? word : PAGE_ALIASES[word];
    if (page) return { kind: 'go', page };
  }
  return null;
}

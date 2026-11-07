/**
 * Number series settings, period locks, edit rules and cancellation reversal (prompt 15).
 * Pure functions: the repository does the writing, this decides what is allowed and what it looks like.
 */
import { MAX_NUMBER_LENGTH, formatDocumentNumber, type SeriesSpec } from './numbering';

/* ------------------------------------------------------------------ series settings */

const AFFIX_CHARS = /^[A-Za-z0-9/-]*$/;
const TOKENS = ['{FY}', '{YYYY}', '{MM}'] as const;
/** The longest each token can render: `25-26`, `2025`, `07`. */
const TOKEN_WIDTH: Record<(typeof TOKENS)[number], number> = { '{FY}': 5, '{YYYY}': 4, '{MM}': 2 };

export interface SeriesSettings extends SeriesSpec {
  name: string;
  /** First number used when the series starts (and again after each reset). */
  start: number;
}

export interface SeriesProblem {
  field: 'name' | 'prefix' | 'suffix' | 'padding' | 'start' | 'format';
  message: string;
}

/** Text left once the known tokens are removed. */
const stripTokens = (s: string): string => TOKENS.reduce((t, k) => t.replaceAll(k, ''), s);

/** Rendered width of an affix, with every token at its widest. */
function affixWidth(s: string): number {
  return TOKENS.reduce(
    (w, k) => w - (s.split(k).length - 1) * (k.length - TOKEN_WIDTH[k]),
    s.length,
  );
}

/**
 * How many characters of the 16 allowed are left for the serial after the prefix and suffix, so how
 * many digits the series can reach before the number breaks Rule 46(b).
 */
export function serialDigitsAvailable(spec: Pick<SeriesSpec, 'prefix' | 'suffix'>): number {
  return MAX_NUMBER_LENGTH - affixWidth(spec.prefix) - affixWidth(spec.suffix);
}

/** The highest serial a series can issue (one digit short of overflowing the limit). */
export function lastSerial(spec: Pick<SeriesSpec, 'prefix' | 'suffix'>): number {
  const digits = serialDigitsAvailable(spec);
  return digits <= 0 ? 0 : 10 ** Math.min(digits, 15) - 1;
}

/** Everything wrong with a series, so the form can show it before saving (FR-040). */
export function validateSeries(s: SeriesSettings): SeriesProblem[] {
  const out: SeriesProblem[] = [];
  const add = (field: SeriesProblem['field'], message: string) => out.push({ field, message });
  if (!s.name.trim()) add('name', 'Give the series a name.');
  for (const field of ['prefix', 'suffix'] as const) {
    const value = s[field];
    if (value.includes('{') || value.includes('}')) {
      const rest = stripTokens(value);
      if (rest.includes('{') || rest.includes('}'))
        add(field, 'Only {FY}, {YYYY} and {MM} can go inside braces.');
    }
    if (!AFFIX_CHARS.test(stripTokens(value)))
      add(field, 'Use only letters, digits, hyphen and slash (GST rule 46).');
  }
  if (!Number.isInteger(s.padding) || s.padding < 1 || s.padding > 10)
    add('padding', 'Padding must be a whole number from 1 to 10.');
  if (!Number.isSafeInteger(s.start) || s.start < 1) add('start', 'Start must be 1 or more.');
  if (out.length > 0) return out;

  const room = serialDigitsAvailable(s);
  if (room < 1) {
    add('format', `The prefix and suffix alone take ${MAX_NUMBER_LENGTH} characters or more.`);
  } else if (s.padding > room) {
    add(
      'format',
      `With this prefix and suffix a number can be at most ${MAX_NUMBER_LENGTH} characters, so padding can be ${room} at most.`,
    );
  } else if (s.start > lastSerial(s)) {
    add('start', 'This start number would not fit in 16 characters.');
  }
  return out;
}

/** What the next number will look like for a document on `date`, or null when the settings are invalid. */
export function previewSeries(
  s: SeriesSettings,
  next: number,
  date: string,
  fyStartMonth = 4,
): string | null {
  if (validateSeries(s).length > 0) return null;
  try {
    return formatDocumentNumber(s, Math.max(next, s.start), date, fyStartMonth);
  } catch {
    return null;
  }
}

/**
 * Series that would hand out the same text for one type. Two series of one document type must differ
 * in prefix or suffix, or a number could repeat (the register is unique per type and number).
 */
export function seriesClash(
  a: Pick<SeriesSpec, 'prefix' | 'suffix'>,
  b: Pick<SeriesSpec, 'prefix' | 'suffix'>,
): boolean {
  return a.prefix === b.prefix && a.suffix === b.suffix;
}

/**
 * Number given to a document issued offline before the device has a range to draw from:
 * `PROV-<device tag>-0001`. The tag keeps two devices from making the same one. A provisional number is
 * never a tax invoice number: the server replaces it with the next real number when the document syncs.
 */
export function provisionalNumber(counter: number, deviceTag = ''): string {
  const tag = deviceTag
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 8);
  return `PROV-${tag ? `${tag}-` : ''}${String(counter).padStart(4, '0')}`;
}

export const isProvisional = (n: string | null | undefined): boolean =>
  !!n && /^PROV-(?:[A-Z0-9]{1,8}-)?\d+$/.test(n);

/* ------------------------------------------------------------------ period lock */

export interface PeriodLock {
  /** Documents dated on or before this day are locked. */
  until: string;
}

/** Is a document dated `date` inside a locked period? ISO dates compare as text. */
export const isLockedDate = (lock: PeriodLock | null | undefined, date: string): boolean =>
  !!lock && date <= lock.until;

/* ------------------------------------------------------------------ editing after issue */

/** Fields that never change money, tax or what was supplied; they can be edited at any time. */
export const NON_FINANCIAL_FIELDS = ['notes', 'terms', 'reference', 'due_date'] as const;
export type NonFinancialField = (typeof NON_FINANCIAL_FIELDS)[number];

export type EditKind = 'none' | 'non_financial' | 'financial';

/** Is any changed field financial? An empty change is not an edit. */
export function classifyEdit(changed: readonly string[]): EditKind {
  if (changed.length === 0) return 'none';
  return changed.every((f) => (NON_FINANCIAL_FIELDS as readonly string[]).includes(f))
    ? 'non_financial'
    : 'financial';
}

/* ------------------------------------------------------------------ cancellation */

export interface ReversibleEntry {
  account: string;
  debitPaise: bigint;
  creditPaise: bigint;
}

/** The contra entries that cancel a set of postings: same accounts, debit and credit swapped. */
export function reverseEntries<T extends ReversibleEntry>(entries: readonly T[]): T[] {
  return entries.map((e) => ({ ...e, debitPaise: e.creditPaise, creditPaise: e.debitPaise }));
}

/** Statuses a cancelled document can be reached from, and why the rest cannot. */
export function cancelBlocker(input: { status: string; hasIrn: boolean }): string | null {
  if (input.status === 'cancelled') return 'This document is already cancelled.';
  if (input.status !== 'issued')
    return 'Only issued documents can be cancelled; discard a draft instead.';
  if (input.hasIrn)
    return 'An e-invoiced document must be cancelled on the e-invoice portal first. This arrives with e-invoicing.';
  return null;
}

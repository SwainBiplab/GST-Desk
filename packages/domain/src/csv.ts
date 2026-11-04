/**
 * CSV reading and writing, and strict number parsing for imports. Pure TypeScript, no I/O.
 *
 * Reading copes with what Indian spreadsheets produce: a UTF-8 byte order mark, `;` or tab
 * delimiters, quoted cells with commas and line breaks, CRLF, and Indian digit grouping.
 * Writing neutralises spreadsheet formulas (CSV injection).
 */

export type Delimiter = ',' | ';' | '\t' | '|';

export class CsvError extends Error {
  override name = 'CsvError';
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
  }
}

export interface ParsedCsv {
  delimiter: Delimiter;
  /** Non-blank rows. */
  rows: string[][];
  /** Physical 1-based line each row starts on, parallel to `rows`. Quoted line breaks make these differ from row numbers. */
  lines: number[];
}

const BOM = String.fromCharCode(0xfeff);

export const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);

const DELIMITERS: Delimiter[] = [',', ';', '\t', '|'];

/** Pick the delimiter that appears most often outside quotes on the first non-blank line. */
export function detectDelimiter(text: string): Delimiter {
  const counts = new Map<Delimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of stripBom(text)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if ([...counts.values()].some((n) => n > 0)) break;
    } else if (!quoted && counts.has(ch as Delimiter)) {
      counts.set(ch as Delimiter, counts.get(ch as Delimiter)! + 1);
    }
  }
  let best: Delimiter = ',';
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/** Parse CSV text. Blank rows are dropped; every other row keeps its cells exactly (not trimmed). */
export function parseCsv(input: string, opts: { delimiter?: Delimiter } = {}): ParsedCsv {
  const text = stripBom(input);
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let cellWasQuoted = false;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 1;

  const endCell = () => {
    row.push(cell);
    cell = '';
    cellWasQuoted = false;
  };
  const endRow = () => {
    endCell();
    const blank = row.length === 1 && row[0] === '';
    if (!blank) {
      rows.push(row);
      lines.push(rowLine);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '' && !cellWasQuoted) {
      quoted = true;
      cellWasQuoted = true;
      quoteLine = line;
    } else if (ch === delimiter) endCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
    } else cell += ch;
  }
  if (quoted) throw new CsvError('a quoted cell is never closed', quoteLine);
  if (cell !== '' || row.length > 0 || cellWasQuoted) endRow();
  return { delimiter, rows, lines };
}

/* ------------------------------------------------------------------ writing */

/**
 * One CSV cell. Text starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading
 * apostrophe so a spreadsheet shows it instead of running it. Numbers that are negative on
 * purpose pass `numeric: true`.
 */
export function csvCell(value: string, opts: { numeric?: boolean } = {}): string {
  let v = value;
  if (!opts.numeric && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export type CsvValue = string | { numeric: string };

/** Rows to CSV text: CRLF line ends and a byte order mark so Excel reads Indian names correctly. */
export function toCsv(rows: CsvValue[][]): string {
  const body = rows
    .map((r) =>
      r
        .map((c) => (typeof c === 'string' ? csvCell(c) : csvCell(c.numeric, { numeric: true })))
        .join(','),
    )
    .join('\r\n');
  return `${BOM}${body}\r\n`;
}

/* ------------------------------------------------------------------ numbers */

const GROUPED = /^\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d*)?$|^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/**
 * Strictly parse a decimal as spreadsheets and people write it, to an integer scaled by 10^scale.
 * Accepts `₹`, `Rs.`, `INR` prefixes, a trailing `/-` or `%`, `(1,234.00)` as negative, and
 * Indian (1,23,456.50) or western (123,456.50) grouping.
 *
 * Returns `undefined` for a blank cell and `null` when the text is not a number or has more
 * decimals than `scale` allows (nothing is rounded silently).
 */
export function parseScaledStrict(
  text: string,
  scale: number,
  opts: { allowNegative?: boolean } = {},
): number | undefined | null {
  let s = text.replace(/−/g, '-').trim();
  if (s === '') return undefined;
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1]!.trim();
  }
  s = s
    .replace(/^(?:₹|rs\.?|inr)\s*/i, '')
    .replace(/\s*(?:\/-|%)$/, '')
    .trim();
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) s = s.slice(1).trim();
  s = s.replace(/^(?:₹|rs\.?|inr)\s*/i, '');
  if (/\s/.test(s)) s = s.replace(/\s/g, '');
  if (s.includes(',')) {
    if (!GROUPED.test(s)) return null;
    s = s.replace(/,/g, '');
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) return null;
  const frac = m[2] ?? '';
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) return null;
  const digits = `${m[1] || '0'}${frac.slice(0, scale).padEnd(scale, '0')}`;
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return null;
  if (negative && value !== 0 && !opts.allowNegative) return null;
  return negative ? -value : value;
}

/** Rupees to integer paise. */
export const parseAmountPaise = (t: string, o?: { allowNegative?: boolean }) =>
  parseScaledStrict(t, 2, o);
/** A percentage to basis points: "18" and "18%" give 1800, "1.5" gives 150. */
export const parseRateBp = (t: string) => parseScaledStrict(t, 2);
/** A quantity to micro-units. */
export const parseQtyMicros = (t: string, o?: { allowNegative?: boolean }) =>
  parseScaledStrict(t, 6, o);

/** True for "yes", "y", "true", "1" (and the opposite words). `undefined` for blank, `null` otherwise. */
export function parseBool(text: string): boolean | undefined | null {
  const s = text.trim().toLowerCase();
  if (s === '') return undefined;
  if (['yes', 'y', 'true', '1', 't'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'f'].includes(s)) return false;
  return null;
}

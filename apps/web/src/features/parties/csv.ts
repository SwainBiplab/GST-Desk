import type { Statement } from '@gst/domain';
import { toDecimalString } from '@gst/domain';

/**
 * One CSV cell. Values that start with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with an
 * apostrophe so a spreadsheet shows text instead of running it as a formula. Numbers that are
 * negative on purpose should go through `money()` and are exempt.
 */
export function csvCell(value: string, opts: { numeric?: boolean } = {}): string {
  let v = value;
  if (!opts.numeric && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Rows to CSV text (CRLF line ends, UTF-8 byte order mark so Excel reads Indian names correctly). */
export function toCsv(rows: (string | { numeric: string })[][]): string {
  const body = rows
    .map((r) =>
      r
        .map((c) => (typeof c === 'string' ? csvCell(c) : csvCell(c.numeric, { numeric: true })))
        .join(','),
    )
    .join('\r\n');
  return `\uFEFF${body}\r\n`;
}

/** Paise as a plain decimal string, for spreadsheets: 12345 -> "123.45". */
export const money = (paise: bigint | number): { numeric: string } => ({
  numeric: toDecimalString(BigInt(paise)),
});

export function statementCsv(s: Statement): string {
  const rows: (string | { numeric: string })[][] = [
    ['Date', 'Type', 'Reference', 'Description', 'Debit', 'Credit', 'Balance'],
  ];
  if (s.openingBalancePaise !== 0n) {
    rows.push(['', '', '', 'Balance brought forward', '', '', money(s.openingBalancePaise)]);
  }
  for (const l of s.lines) {
    rows.push([
      l.date,
      l.kind,
      l.ref,
      l.description,
      l.debitPaise ? money(l.debitPaise) : '',
      l.creditPaise ? money(l.creditPaise) : '',
      money(l.balancePaise),
    ]);
  }
  return toCsv(rows);
}

export interface PartyCsvRow {
  name: string;
  type: string;
  gstin: string;
  phone: string;
  city: string;
  state: string;
  balancePaise: bigint;
  overduePaise: bigint;
}

export function partiesCsv(rows: PartyCsvRow[]): string {
  return toCsv([
    ['Name', 'Type', 'GSTIN', 'Phone', 'City', 'State', 'Outstanding', 'Overdue'],
    ...rows.map((r) => [
      r.name,
      r.type,
      r.gstin,
      r.phone,
      r.city,
      r.state,
      money(r.balancePaise),
      money(r.overduePaise),
    ]),
  ]);
}

/** Save text as a file through the browser. */
export function downloadText(
  filename: string,
  text: string,
  mime = 'text/csv;charset=utf-8',
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import { csvCell, toCsv, toDecimalString, type CsvValue, type Statement } from '@gst/domain';

export { csvCell, toCsv };

/** Paise as a plain decimal string, for spreadsheets: 12345 -> "123.45". */
export const money = (paise: bigint | number): { numeric: string } => ({
  numeric: toDecimalString(BigInt(paise)),
});

export function statementCsv(s: Statement): string {
  const rows: CsvValue[][] = [
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

export interface PartyExportRow {
  name: string;
  tradeName: string;
  type: string;
  gstin: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  creditDays: number;
  openingPaise: bigint;
  tags: string;
}

/** Parties in the shape the party import reads back (same headers; a negative balance means we owe them). */
export function partiesImportCsv(rows: PartyExportRow[]): string {
  return toCsv([
    [
      'Name',
      'Trade Name',
      'Type',
      'GSTIN',
      'Phone',
      'Email',
      'Address',
      'City',
      'State',
      'Pincode',
      'Credit Days',
      'Opening Balance',
      'Tags',
    ],
    ...rows.map((r): CsvValue[] => [
      r.name,
      r.tradeName,
      r.type,
      r.gstin,
      r.phone,
      r.email,
      r.address,
      r.city,
      r.state,
      r.pincode,
      { numeric: String(r.creditDays) },
      r.openingPaise === 0n ? '' : money(r.openingPaise),
      r.tags,
    ]),
  ]);
}

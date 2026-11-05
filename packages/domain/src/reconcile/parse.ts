/**
 * Reading GSTR-2B. The portal's JSON is read by a versioned parser (`PARSERS`), so a change of layout is
 * a new entry and the matching never changes. The Excel download is read from a table of rows by
 * recognising the column headings, since its layout cannot be fixed by position.
 *
 * STATUS: both layouts are reconstructed from public documentation and have NOT been checked against
 * a real downloaded GSTR-2B. The reviewer must try a real file (see docs/compliance/gstr2b-review.md).
 */
import { parseScaled } from '../money';

import type { Entry2B, Entry2BType, ParsedReturn2B } from './types';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v == null ? '' : String(v).trim());

/** Rupees as a JSON number or text to whole paise, exactly. `null` when it is not an amount. */
export function toPaise(v: unknown): number | null {
  if (v == null || v === '') return 0;
  const text = String(v)
    .replace(/[₹,\s]/g, '')
    .replace(/^Rs\.?/i, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  try {
    return Number(parseScaled(text, 2));
  } catch {
    return null;
  }
}

/** DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, or a spreadsheet date number, to YYYY-MM-DD. `null` when it is none. */
export function toIsoDate(v: unknown): string | null {
  const t = str(v);
  let m = /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(t);
  if (m) return valid(`${m[3]}-${m[2]}-${m[1]}`);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return valid(`${m[1]}-${m[2]}-${m[3]}`);
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    // a spreadsheet serial: days since 30 December 1899
    const ms = Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

function valid(iso: string): string | null {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** `072025`, `Jul-2025`, `07-2025` or `2025-07` to MMYYYY; empty when it is none of them. */
export function toPeriod(v: unknown): string {
  const t = str(v);
  if (/^\d{6}$/.test(t)) return t;
  let m = /^(\d{2})[-/](\d{4})$/.exec(t);
  if (m) return `${m[1]}${m[2]}`;
  m = /^(\d{4})-(\d{2})$/.exec(t);
  if (m) return `${m[2]}${m[1]}`;
  m = /^([A-Za-z]{3})[a-z]*[-\s](\d{2}|\d{4})$/.exec(t);
  if (m) {
    const mon = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ].indexOf(m[1]!.toLowerCase());
    if (mon >= 0)
      return `${String(mon + 1).padStart(2, '0')}${m[2]!.length === 2 ? `20${m[2]}` : m[2]}`;
  }
  return '';
}

export type ParsedEntry = ParsedReturn2B['entries'][number];

function taxOf(doc: Json, problems: string[], where: string) {
  const items = arr(doc['items']).map(obj);
  const src = items.length > 0 ? items : [doc];
  const sum = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const it of src) {
    for (const [k, key] of [
      ['taxable', 'txval'],
      ['igst', 'igst'],
      ['cgst', 'cgst'],
      ['sgst', 'sgst'],
      ['cess', 'cess'],
    ] as const) {
      const p = toPaise(it[key]);
      if (p === null) problems.push(`${where}: ${key} is not an amount`);
      else sum[k] += p;
    }
  }
  return sum;
}

function itc(v: unknown): 'Y' | 'N' | '' {
  const t = str(v).toUpperCase();
  return t === 'Y' || t === 'N' ? t : '';
}

/** The GSTR-2B JSON as the portal's download gives it (layout "v1"). */
export function parseJsonV1(root: Json): ParsedReturn2B {
  const data = obj(root['data']);
  const body = Object.keys(data).length > 0 ? data : root;
  const problems: string[] = [];
  const entries: ParsedEntry[] = [];
  const docdata = obj(body['docdata']);
  let reverseCharge = 0;

  for (const sup of arr(docdata['b2b']).map(obj)) {
    const gstin = str(sup['ctin']);
    for (const inv of arr(sup['inv']).map(obj)) {
      if (str(inv['rev']).toUpperCase() === 'Y') {
        reverseCharge += 1;
        continue;
      }
      const number = str(inv['inum']);
      const date = toIsoDate(inv['dt']);
      const where = `${gstin} ${number}`;
      if (!gstin || !number || !date) {
        problems.push(
          `an invoice of ${gstin || 'an unknown supplier'} was skipped: ${!number ? 'no number' : !date ? 'no valid date' : 'no GSTIN'}`,
        );
        continue;
      }
      entries.push({
        supplierGstin: gstin,
        supplierName: str(sup['trdnm']),
        docType: 'invoice',
        number,
        date,
        ...taxOf(inv, problems, where),
        itcAvailable: itc(inv['itcavl']),
        reason: str(inv['rsn']),
        supplierPeriod: toPeriod(sup['supprd']),
      });
    }
  }
  for (const sup of arr(docdata['cdnr']).map(obj)) {
    const gstin = str(sup['ctin']);
    for (const nt of arr(sup['nt']).map(obj)) {
      if (str(nt['rev']).toUpperCase() === 'Y') {
        reverseCharge += 1;
        continue;
      }
      const number = str(nt['ntnum']);
      const date = toIsoDate(nt['dt']);
      const type: Entry2BType = str(nt['typ']).toUpperCase().startsWith('D')
        ? 'debit_note'
        : 'credit_note';
      if (!gstin || !number || !date) {
        problems.push(
          `a note of ${gstin || 'an unknown supplier'} was skipped: ${!number ? 'no number' : !date ? 'no valid date' : 'no GSTIN'}`,
        );
        continue;
      }
      entries.push({
        supplierGstin: gstin,
        supplierName: str(sup['trdnm']),
        docType: type,
        number,
        date,
        ...taxOf(nt, problems, `${gstin} ${number}`),
        itcAvailable: itc(nt['itcavl']),
        reason: str(nt['rsn']),
        supplierPeriod: toPeriod(sup['supprd']),
      });
    }
  }
  for (const k of Object.keys(docdata)) {
    if (!['b2b', 'cdnr'].includes(k) && arr(docdata[k]).length > 0)
      problems.push(
        `the ${k} section is not imported (only invoices and credit and debit notes are)`,
      );
  }
  return {
    period: toPeriod(body['rtnprd']),
    gstin: str(body['gstin']),
    version: 'v1',
    entries,
    problems,
    reverseChargeLeftOut: reverseCharge,
  };
}

/** Parsers by layout. A new layout of the file is a new entry here, chosen by `detect`. */
export const PARSERS: {
  version: string;
  detect: (root: Json) => boolean;
  parse: (root: Json) => ParsedReturn2B;
}[] = [
  {
    version: 'v1',
    detect: (root) => {
      const d = obj(root['data']);
      return 'docdata' in d || 'docdata' in root;
    },
    parse: parseJsonV1,
  },
];

/** Read a GSTR-2B JSON text. Never throws: what could not be read is in `problems`. */
export function parse2bJson(text: string): ParsedReturn2B {
  let root: Json;
  try {
    root = obj(JSON.parse(text));
  } catch {
    return {
      period: '',
      gstin: '',
      version: '',
      entries: [],
      problems: ['The file is not valid JSON.'],
    };
  }
  const parser = PARSERS.find((p) => p.detect(root));
  if (!parser) {
    return {
      period: '',
      gstin: '',
      version: '',
      entries: [],
      problems: ['This does not look like a GSTR-2B file (no document data was found).'],
    };
  }
  return parser.parse(root);
}

/* ------------------------------------------------------------------ the Excel layout */

const COLUMNS: Record<string, RegExp> = {
  gstin: /gstin/i,
  name: /trade|legal|supplier name|name of supplier/i,
  number: /(invoice|note|document|bill)\s*(number|no)|^number$|^invoice$/i,
  type: /note type|document type|^type$/i,
  date: /(invoice|note|document|bill)?\s*date/i,
  taxable: /taxable/i,
  igst: /integrated|igst/i,
  cgst: /central|cgst/i,
  sgst: /state|sgst|ut tax/i,
  cess: /cess/i,
  itc: /itc availab|eligib/i,
  reason: /reason/i,
  supplierPeriod: /period|filing/i,
  reverse: /reverse/i,
};

/**
 * Read GSTR-2B rows from a spreadsheet (the first row with a GSTIN and a number heading is the header).
 * `period` and `gstin` come from the person, because the sheet's own header block varies.
 */
export function parse2bTable(
  rows: readonly (readonly string[])[],
  meta: { period: string; gstin: string },
): ParsedReturn2B {
  const problems: string[] = [];
  const entries: ParsedEntry[] = [];
  let reverseCharge = 0;
  const headerAt = rows.findIndex(
    (r) => r.some((c) => COLUMNS['gstin']!.test(c)) && r.some((c) => COLUMNS['number']!.test(c)),
  );
  if (headerAt < 0) {
    return {
      ...meta,
      version: 'xlsx-v1',
      entries,
      problems: ['No table with a GSTIN column and an invoice number column was found.'],
    };
  }
  const head = rows[headerAt]!;
  const col: Partial<Record<keyof typeof COLUMNS, number>> = {};
  for (const key of Object.keys(COLUMNS)) {
    // the first heading that matches, and a heading only serves one meaning
    const used = new Set(Object.values(col));
    const i = head.findIndex((c, idx) => !used.has(idx) && COLUMNS[key]!.test(c));
    if (i >= 0) col[key] = i;
  }
  for (let r = headerAt + 1; r < rows.length; r++) {
    const row = rows[r]!;
    const cell = (k: keyof typeof COLUMNS) => (col[k] === undefined ? '' : str(row[col[k]!]));
    if (row.every((c) => !str(c))) continue;
    const gstin = cell('gstin');
    const number = cell('number');
    const date = toIsoDate(cell('date'));
    if (!/^\d{2}[A-Z0-9]{13}$/i.test(gstin) || !number) continue; // totals and blank rows
    if (/^(y|yes)$/i.test(cell('reverse'))) {
      reverseCharge += 1;
      continue;
    }
    if (!date) {
      problems.push(`row ${r + 1}: ${gstin} ${number} has no valid date and was skipped`);
      continue;
    }
    const amount = (k: keyof typeof COLUMNS): number => {
      const p = toPaise(cell(k));
      if (p === null) {
        problems.push(`row ${r + 1}: ${k} is not an amount`);
        return 0;
      }
      return p;
    };
    const t = cell('type').toLowerCase();
    entries.push({
      supplierGstin: gstin.toUpperCase(),
      supplierName: cell('name'),
      docType: t.startsWith('d') ? 'debit_note' : t.startsWith('c') ? 'credit_note' : 'invoice',
      number,
      date,
      taxable: amount('taxable'),
      igst: amount('igst'),
      cgst: amount('cgst'),
      sgst: amount('sgst'),
      cess: amount('cess'),
      itcAvailable: itc(
        /^(yes|y)$/i.test(cell('itc')) ? 'Y' : /^(no|n)$/i.test(cell('itc')) ? 'N' : '',
      ),
      reason: cell('reason'),
      supplierPeriod: toPeriod(cell('supplierPeriod')),
    });
  }
  return { ...meta, version: 'xlsx-v1', entries, problems, reverseChargeLeftOut: reverseCharge };
}

export type { Entry2B };

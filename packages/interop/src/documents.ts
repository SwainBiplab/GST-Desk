/**
 * Documents with lines from spreadsheet rows: a file with one row per line (the invoice number repeats),
 * or a workbook with a header sheet and a lines sheet joined on the invoice number. The column mapping is
 * the same machinery parties and items use, with the spellings Vyapar's reports use among the aliases.
 *
 * Money and quantities are read strictly: a cell that is not a number is a problem on that row, never a
 * silent zero.
 */
import {
  detectMapping,
  normHeader,
  parseAmountPaise,
  parseQtyMicros,
  parseRateBp,
  readRow,
  type DocumentType,
  type FieldDef,
  type Mapping,
  type SavedMapping,
  STATES,
} from '@gst/domain';

import type { ImportDocument, ImportIssue, ImportLine, ImportSource } from './types';

export const DOCUMENT_FIELDS: readonly FieldDef[] = [
  {
    key: 'number',
    required: true,
    aliases: [
      'invoiceno',
      'invoicenumber',
      'invno',
      'billno',
      'billnumber',
      'voucherno',
      'refno',
      'documentno',
      'no',
    ],
  },
  {
    key: 'date',
    required: true,
    aliases: ['invoicedate', 'billdate', 'voucherdate', 'documentdate', 'transactiondate'],
  },
  {
    key: 'type',
    aliases: ['transactiontype', 'documenttype', 'vouchertype', 'invoicetype', 'txntype'],
  },
  {
    key: 'party',
    required: true,
    aliases: [
      'partyname',
      'customer',
      'supplier',
      'vendor',
      'customername',
      'suppliername',
      'vendorname',
      'buyername',
      'ledger',
      'ledgername',
      'name',
    ],
  },
  {
    key: 'gstin',
    aliases: ['partygstin', 'gstno', 'gstnumber', 'customergstin', 'suppliergstin', 'gstinuin'],
  },
  { key: 'pos', aliases: ['placeofsupply', 'state', 'statename', 'partystate'] },
  {
    key: 'item',
    aliases: [
      'itemname',
      'product',
      'productname',
      'description',
      'itemdescription',
      'particulars',
    ],
  },
  { key: 'hsn', aliases: ['hsncode', 'hsnsac', 'sac', 'hsn/sac'] },
  { key: 'qty', aliases: ['quantity', 'qnty', 'units'] },
  { key: 'unit', aliases: ['uom', 'unitofmeasure', 'primaryunit'] },
  {
    key: 'rate',
    aliases: ['priceunit', 'priceperunit', 'unitprice', 'price', 'sellingprice', 'rateperunit'],
  },
  { key: 'discount', aliases: ['discountamount', 'discountamt', 'disc'] },
  {
    key: 'discountPct',
    aliases: ['discountpercent', 'discountpercentage', 'discpercent', 'disc%'],
  },
  {
    key: 'gstRate',
    aliases: ['taxpercent', 'taxrate', 'gstpercent', 'gst', 'tax', 'taxpercentage', 'gstrate'],
  },
  { key: 'cess', aliases: ['cesspercent', 'cessrate'] },
  { key: 'taxable', aliases: ['taxableamount', 'taxablevalue', 'amountbeforetax', 'netamount'] },
  {
    key: 'total',
    aliases: ['totalamount', 'invoiceamount', 'invoicetotal', 'grandtotal', 'amount'],
  },
  { key: 'reverseCharge', aliases: ['reversecharge', 'rcm'] },
  { key: 'narration', aliases: ['notes', 'remarks', 'narration', 'reference'] },
];

/** The words spreadsheets use for a document type, to the type. */
export function documentTypeFromText(text: string): DocumentType | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (t === '') return null;
  if (/(sale|sales|tax) ?(invoice|bill)?$/.test(t) && !/return|credit|order/.test(t))
    return 'tax_invoice';
  if (/^(invoice|sale|sales|tax invoice|sale invoice|sales invoice)$/.test(t)) return 'tax_invoice';
  if (/bill of supply/.test(t)) return 'bill_of_supply';
  if (/(sale|sales) return|credit note/.test(t)) return 'credit_note';
  if (/purchase return|debit note/.test(t))
    return /purchase/.test(t) ? 'purchase_return' : 'debit_note';
  if (/purchase/.test(t) && !/order/.test(t)) return 'purchase_bill';
  if (/expense/.test(t)) return 'expense';
  if (/estimate|quotation|quote/.test(t)) return 'quotation';
  if (/proforma/.test(t)) return 'proforma';
  if (/challan/.test(t)) return 'delivery_challan';
  return null;
}

const STATE_BY_NAME = new Map(Object.entries(STATES).map(([c, n]) => [n.toLowerCase(), c]));
const posCode = (t: string): string => {
  const v = t.trim();
  if (/^\d{2}$/.test(v)) return v;
  const m = /\((\d{2})\)/.exec(v);
  if (m) return m[1]!;
  return STATE_BY_NAME.get(v.toLowerCase().replace(/\s*\(\d+\)$/, '')) ?? '';
};

/** A date typed as `dd-mm-yyyy`, `dd/mm/yyyy`, `yyyy-mm-dd`, or an Excel serial number, to an ISO date. */
export function sheetDate(text: string): string {
  const t = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  let y: number;
  let mo: number;
  let d: number;
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t))) {
    d = Number(m[1]);
    mo = Number(m[2]);
    y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  } else if (/^\d{5}(\.\d+)?$/.test(t)) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000;
    const dt = new Date(ms);
    y = dt.getUTCFullYear();
    mo = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  } else return '';
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > days) return '';
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface DocumentRowsInput {
  source: ImportSource;
  headers: readonly string[];
  /** Data rows, no header. */
  rows: readonly (readonly string[])[];
  /** The line of the file each row came from (1-based), for the report. */
  lines: readonly number[];
  mapping: Mapping;
  /** The type for rows that carry no type column or one that is not recognised. */
  defaultType: DocumentType;
}

/** Guess the columns. A "%" in a heading is spelled out first, because the comparison drops it and "Discount %" would match "Discount". */
export function detectDocumentMapping(
  headers: readonly string[],
  saved?: SavedMapping | null,
): Mapping {
  return detectMapping(
    headers.map((h) => h.replace(/%/g, ' percent ')),
    DOCUMENT_FIELDS,
    saved,
  );
}

const money = (t: string): bigint | null | undefined => {
  const v = parseAmountPaise(t.replace(/[₹]/g, '').replace(/^Rs\.?\s*/i, ''), {
    allowNegative: true,
  });
  return v === undefined ? undefined : v === null ? null : BigInt(v);
};

/** Turn rows into documents, one per number and type, with a problem for every cell that cannot be read. */
export function documentsFromRows(input: DocumentRowsInput): {
  documents: ImportDocument[];
  issues: ImportIssue[];
} {
  const issues: ImportIssue[] = [];
  const docs = new Map<string, ImportDocument>();
  const add = (severity: ImportIssue['severity'], line: number, message: string) =>
    issues.push({ severity, ref: `line ${line}`, message });

  input.rows.forEach((cells, i) => {
    const line = input.lines[i] ?? i + 2;
    const r = readRow(cells, input.mapping);
    const get = (k: string) => (r[k] ?? '').trim();
    if (Object.values(r).every((v) => (v ?? '').trim() === '')) return;

    const number = get('number');
    if (!number) return add('error', line, 'no invoice number');
    const date = sheetDate(get('date'));
    if (!date) return add('error', line, `"${get('date')}" is not a date`);
    const typeText = get('type');
    const typed = documentTypeFromText(typeText);
    if (typeText && !typed)
      add('warning', line, `"${typeText}" is not a known type; taken as ${input.defaultType}`);
    const type = typed ?? input.defaultType;
    if (!get('party')) return add('error', line, 'no party name');

    const description = get('item') || '';
    if (!description) return add('error', line, 'no item or description');
    const qtyText = get('qty');
    const qty = qtyText === '' ? 1_000_000 : parseQtyMicros(qtyText);
    if (qty === null || qty === undefined)
      return add('error', line, `"${qtyText}" is not a quantity`);
    const taxableText = get('taxable');
    const taxable = taxableText === '' ? undefined : money(taxableText);
    if (taxable === null) return add('error', line, `"${taxableText}" is not an amount`);
    const rateText = get('rate');
    let rate: bigint | null | undefined = rateText === '' ? undefined : money(rateText);
    if (rate === null) return add('error', line, `"${rateText}" is not an amount`);
    if (rate === undefined) {
      if (taxable === undefined || qty === 0)
        return add('error', line, 'no rate and no taxable amount');
      rate = (taxable * 1_000_000n) / BigInt(qty);
    }
    const gross = (BigInt(qty) * rate) / 1_000_000n;

    let discount = 0n;
    const discText = get('discount');
    const pctText = get('discountPct');
    if (discText !== '') {
      const v = money(discText);
      if (v === null || v === undefined)
        return add('error', line, `"${discText}" is not an amount`);
      discount = v;
    } else if (pctText !== '') {
      const bp = parseRateBp(pctText);
      if (bp === null || bp === undefined)
        return add('error', line, `"${pctText}" is not a percentage`);
      discount = (gross * BigInt(bp) + 5000n) / 10_000n;
    }
    if (discount < 0n || discount > gross)
      return add('error', line, 'the discount is more than the line value');

    const gstText = get('gstRate');
    let gstRateBp: number | null = null;
    if (gstText !== '') {
      const bp = parseRateBp(gstText);
      if (bp === null || bp === undefined)
        return add('error', line, `"${gstText}" is not a tax rate`);
      gstRateBp = bp;
    }
    const cessText = get('cess');
    let cessBp = 0;
    if (cessText !== '') {
      const bp = parseRateBp(cessText);
      if (bp === null || bp === undefined) return add('error', line, `"${cessText}" is not a rate`);
      cessBp = bp;
    }

    const l: ImportLine = {
      description,
      itemName: description,
      hsn: get('hsn'),
      qtyMicros: BigInt(qty),
      unit: get('unit'),
      ratePaise: rate,
      discountPaise: discount,
      taxablePaise: taxable ?? gross - discount,
      gstRateBp,
      cessBp,
    };

    const key = `${type}|${number}`;
    const existing = docs.get(key);
    if (existing) {
      if (existing.date !== date)
        add('warning', line, `${number}: a different date from its first line; the first is kept`);
      if (existing.partyName !== get('party'))
        add('warning', line, `${number}: a different party from its first line; the first is kept`);
      existing.lines.push(l);
      return;
    }
    const totalText = get('total');
    const total = totalText === '' ? null : money(totalText);
    docs.set(key, {
      source: input.source,
      ref: `line ${line}`,
      type,
      number,
      date,
      partyName: get('party'),
      partyGstin: get('gstin').toUpperCase(),
      placeOfSupply: posCode(get('pos')),
      reverseCharge: /^(y|yes|true|1)$/i.test(get('reverseCharge')),
      lines: [l],
      fileTotalPaise: total ?? null,
      fileTaxPaise: null,
      narration: get('narration'),
    });
  });
  return { documents: [...docs.values()], issues };
}

/**
 * Join a header sheet and a lines sheet on the invoice number into one sheet of rows, one per line, with
 * the header columns added after the line columns. A line with no header is reported, not dropped silently.
 */
export function joinSheets(
  head: { headers: readonly string[]; rows: readonly (readonly string[])[] },
  lines: { headers: readonly string[]; rows: readonly (readonly string[])[] },
  headKey: number,
  linesKey: number,
): { headers: string[]; rows: string[][]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const byKey = new Map<string, readonly string[]>();
  for (const r of head.rows) byKey.set((r[headKey] ?? '').trim(), r);
  const have = new Set(lines.headers.map(normHeader));
  const extra = head.headers.map((h, i) => ({ h, i })).filter(({ h }) => !have.has(normHeader(h)));
  const headers = [...lines.headers, ...extra.map((e) => e.h)];
  const rows: string[][] = [];
  lines.rows.forEach((r, n) => {
    const key = (r[linesKey] ?? '').trim();
    const h = byKey.get(key);
    if (!h) {
      issues.push({
        severity: 'error',
        ref: `lines sheet row ${n + 2}`,
        message: `no invoice ${key || '(blank)'} on the header sheet`,
      });
      return;
    }
    rows.push([...r, ...extra.map((e) => h[e.i] ?? '')]);
  });
  return { headers, rows, issues };
}

/** An example file to download, with the headings the importer knows best. */
export const DOCUMENT_TEMPLATE =
  'Invoice No,Date,Type,Party Name,GSTIN,Place of Supply,Item,HSN,Qty,Unit,Rate,Discount %,GST %\n' +
  'INV-001,2025-04-10,Sale,Sharma Traders,27AAPFU0939F1ZV,Maharashtra,Cement bag,2523,10,Bag,350,0,18\n' +
  'INV-001,2025-04-10,Sale,Sharma Traders,27AAPFU0939F1ZV,Maharashtra,Delivery,9965,1,Nos,500,0,18\n' +
  'PB-007,2025-04-12,Purchase,Kumar Cements,29AABCU9603R1ZJ,Karnataka,Cement bag,2523,100,Bag,300,0,18\n';

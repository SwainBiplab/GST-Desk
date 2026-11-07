/**
 * A purchase bill from OCR text without a model: labels and patterns Indian invoices share. It is the
 * Tier 0 extractor (always available), the cross-check for a model's answer, and the floor the evals
 * measure models against. Every field carries its own confidence.
 */
import { gstinCheckChar } from '@gst/domain';

import type { PurchaseBill } from '../../schemas';

export interface RulesExtraction {
  bill: PurchaseBill;
  fieldConfidence: Record<string, number>;
  /** Which lines of the text became bill lines, for highlighting. */
  lineRows: number[];
}

const GSTIN = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g;
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const LABEL_WORDS =
  /^(tax invoice|invoice|bill of supply|original|duplicate|triplicate|cash memo|retail invoice|gstin|gst no|phone|mobile|email|e-mail|state|address|pan|date|invoice no|bill no|place of supply|original for recipient)/i;
const COMPANY =
  /\b(pvt|private|ltd|limited|llp|traders|trading|enterprises|enterprise|industries|agencies|agency|stores|store|& sons|and sons|co\.|company|corporation|mart|distributors|suppliers|electricals|electronics|textiles|pharma|chemicals|motors|steels|associates)\b/i;
const HEADER = /\b(description|particulars|item|product|goods)\b/i;
const QTY_H = /\b(qty|quantity|nos)\b/i;
const RATE_H = /^(?!.*\b(gst|tax)\b).*\b(rate|price|unit price)\b/i;
const AMT_H = /\b(amount|total|value)\b/i;
const HSN_H = /\b(hsn|sac|hsn\/sac)\b/i;
const TOTAL_LABELS =
  /\b(grand total|total amount|net amount|amount payable|net payable|invoice total|total payable|total)\b/i;
const SUMMARY_ROW =
  /\b(subtotal|sub total|taxable|cgst|sgst|igst|utgst|cess|round ?off|discount|total|amount in words|rupees|bank|ifsc|a\/c|account|terms|e\.? ?&\.? ?o\.? ?e|authori[sz]ed|signatory|thank)\b/i;
/** A row that is a label with a value, not goods: starts with the label, or has `label:` in it. */
const LABEL_ROW =
  /^\s*(tax invoice|invoice|bill no|bill number|bill|date|dated|dt|gstin|gst no|gst reg|phone|mobile|email|e-mail|pin|pincode|state|place of supply|po no|order no|challan|buyer|bill to|ship to|consignee|m\/s|vehicle|transport|due date|payment terms)\b|\b(gstin|gst no|phone|mobile|email|date|dt|invoice no)\s*[:.]/i;
const SKIP_ROW = { test: (row: string) => SUMMARY_ROW.test(row) || LABEL_ROW.test(row) };
const NUM = /(?<![A-Z0-9])-?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?(?![A-Z0-9])/gi;
const PERCENT = /(\d{1,2}(?:\.\d+)?)\s*%/;

const toNumber = (s: string): number => Number(s.replace(/,/g, ''));
const paise = (n: number): number => Math.round(n * 100);

export function parseDate(s: string): string | null {
  const m1 = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/);
  if (m1) {
    const d = Number(m1[1]);
    const m = Number(m1[2]);
    const y = m1[3]!.length === 2 ? 2000 + Number(m1[3]) : Number(m1[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const m2 = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  const m3 = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})[ ,-]+(\d{4})\b/);
  if (m3) {
    const mon = MONTHS[m3[2]!.slice(0, 3).toLowerCase()];
    if (mon)
      return `${m3[3]}-${String(mon).padStart(2, '0')}-${String(Number(m3[1])).padStart(2, '0')}`;
  }
  return null;
}

const validGstin = (g: string): boolean => {
  try {
    return gstinCheckChar(g.slice(0, 14)) === g[14];
  } catch {
    return false;
  }
};

/** The columns of a table row: pieces separated by two or more spaces, or a pipe. */
const cells = (row: string): string[] =>
  row
    .split(/ {2,}|\s\|\s|\t/)
    .map((c) => c.trim())
    .filter(Boolean);

interface Header {
  desc: number;
  hsn: number;
  qty: number;
  rate: number;
  amount: number;
  gst: number;
  cols: number;
}

function headerOf(row: string): Header | null {
  if (!HEADER.test(row) || !(QTY_H.test(row) || RATE_H.test(row) || AMT_H.test(row))) return null;
  const cs = cells(row);
  if (cs.length < 3) return null;
  const find = (re: RegExp) => cs.findIndex((c) => re.test(c));
  return {
    desc: find(HEADER),
    hsn: find(HSN_H),
    qty: find(QTY_H),
    rate: find(RATE_H),
    amount: Math.max(find(/\b(amount|value)\b/i), cs.length - 1),
    gst: find(/\b(gst|tax|igst|cgst)\b.*%|\brate\s*%|\bgst\b/i),
    cols: cs.length,
  };
}

type Line = PurchaseBill['lines'][number];

/** A line from a row the header explains. */
function lineFromHeader(row: string, h: Header): Line | null {
  const cs = cells(row);
  if (cs.length < 3) return null;
  const at = (i: number) => (i >= 0 && i < cs.length ? cs[i]! : '');
  const desc = at(h.desc >= 0 ? h.desc : 0).replace(/^\d{1,2}[.)]\s*/, '');
  if (!/\p{L}{2,}/u.test(desc)) return null;
  const nums = (s: string) => (s.match(NUM) ?? []).map(toNumber);
  const qty = h.qty >= 0 ? nums(at(h.qty))[0] : undefined;
  const rate = h.rate >= 0 ? nums(at(h.rate))[0] : undefined;
  const amount = nums(at(h.amount))[0];
  const hsnCell = h.hsn >= 0 ? at(h.hsn) : '';
  const hsn = hsnCell.match(/\b\d{4,8}\b/)?.[0] ?? null;
  const gst = h.gst >= 0 ? at(h.gst).match(PERCENT)?.[1] : row.match(PERCENT)?.[1];
  if (qty === undefined && rate === undefined && amount === undefined) return null;
  const q = qty ?? (rate && amount ? amount / rate : 1);
  const r = rate ?? (amount && q ? amount / q : 0);
  return {
    description: desc,
    hsn,
    qty: q,
    ratePaise: paise(r),
    gstRateBp: gst ? Math.round(Number(gst) * 100) : 0,
  };
}

const NUM_TOKEN = /^-?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?$/;
const PCT_TOKEN = /^\d{1,2}(?:\.\d+)?%$/;

/**
 * A line from a row with text then numbers: `[sno] desc [hsn] qty [unit] rate [gst%] amount`. The numbers
 * are read from the right, so a size inside the description ("Wire 1.5 sqmm 90m") stays with the words.
 */
function lineFromShape(row: string): Line | null {
  if (SKIP_ROW.test(row)) return null;
  const toks = row.trim().split(/\s+/);
  const tail: string[] = [];
  while (
    toks.length &&
    (NUM_TOKEN.test(toks[toks.length - 1]!) ||
      PCT_TOKEN.test(toks[toks.length - 1]!) ||
      /^(nos|pcs|kg|kgs|ltr|mtr|box|bag|set|pair|doz)\.?$/i.test(toks[toks.length - 1]!))
  )
    tail.unshift(toks.pop()!);
  const numeric = tail.filter((t) => NUM_TOKEN.test(t) || PCT_TOKEN.test(t));
  if (numeric.length < 2) return null;
  let desc = toks
    .join(' ')
    .replace(/^\d{1,2}[.)]?\s+/, '')
    .trim();
  let rest = numeric.filter((t) => !PCT_TOKEN.test(t));
  // an HSN right after the description: 4 to 8 digits with no decimals, with at least two numbers after it
  let hsn: string | null = null;
  if (rest.length >= 3 && /^\d{4,8}$/.test(rest[0]!)) {
    hsn = rest[0]!;
    rest = rest.slice(1);
  }
  if (!/\p{L}{2,}/u.test(desc)) return null;
  if (!desc) desc = '';
  const pctTok = tail.find((t) => PCT_TOKEN.test(t));
  const pct = pctTok ? pctTok.match(PERCENT) : row.match(PERCENT);
  const values = rest.map(toNumber);
  if (values.length < 2) return null;
  const amount = values[values.length - 1]!;
  const qty = values[0]!;
  const rate = values.length >= 3 ? values[1]! : amount / (qty || 1);
  if (qty <= 0 || amount < 0) return null;
  return {
    description: desc,
    hsn,
    qty,
    ratePaise: paise(rate),
    gstRateBp: pct ? Math.round(Number(pct[1]) * 100) : 0,
  };
}

export interface RulesExtractOptions {
  ownGstin?: string | null;
  /** The GST rate for an HSN code from the master, for lines whose rate the bill does not print. */
  rateForHsn?: (hsn: string) => number | null;
}

export function extractBillFromText(text: string, opts: RulesExtractOptions = {}): RulesExtraction {
  const rows = text.split(/\r?\n/).map((r) => r.replace(/\s+$/, ''));
  const conf: Record<string, number> = {};
  const own = (opts.ownGstin ?? '').toUpperCase();

  // supplier GSTIN: the first valid one that is not ours
  const gstins = [...text.toUpperCase().matchAll(GSTIN)].map((m) => m[1]!).filter((g) => g !== own);
  const supplierGstin = gstins[0] ?? null;
  conf['supplierGstin'] = supplierGstin ? (validGstin(supplierGstin) ? 0.95 : 0.6) : 0.3;

  // invoice number
  let invoiceNumber = '';
  for (const r of rows) {
    const m = r.match(
      /\b(?:invoice|bill|inv)\s*(?:no|number|num|#)?\s*[.:#-]*\s*([A-Z0-9][A-Z0-9/-]{0,24})\b/i,
    );
    if (m && !/^(no|number|date|dt)$/i.test(m[1]!) && /\d/.test(m[1]!)) {
      invoiceNumber = m[1]!;
      break;
    }
  }
  conf['invoiceNumber'] = invoiceNumber ? 0.85 : 0.2;

  // date: a labelled one first, else the first date in the top half
  let date = '';
  for (const r of rows) {
    if (/\b(date|dated|dt)\b/i.test(r)) {
      const d = parseDate(r.replace(/.*\b(date|dated|dt)\b/i, ''));
      if (d) {
        date = d;
        conf['date'] = 0.85;
        break;
      }
    }
  }
  if (!date) {
    for (const r of rows.slice(0, Math.max(5, rows.length / 2))) {
      const d = parseDate(r);
      if (d) {
        date = d;
        conf['date'] = 0.55;
        break;
      }
    }
  }
  if (!date) conf['date'] = 0.1;

  // supplier name: above the GSTIN or the invoice line, a line that reads like a name
  const gstinRow = rows.findIndex((r) => supplierGstin && r.toUpperCase().includes(supplierGstin));
  const limit = gstinRow > 0 ? gstinRow : Math.min(rows.length, 6);
  let supplierName = '';
  let nameConf = 0.3;
  const candidates = rows
    .slice(0, limit)
    .map((r) => r.trim())
    .filter((r) => /\p{L}{3,}/u.test(r) && !LABEL_WORDS.test(r) && !GSTIN.test(r));
  const company = candidates.find((r) => COMPANY.test(r));
  if (company) {
    supplierName = company;
    nameConf = 0.8;
  } else if (candidates[0]) {
    supplierName = candidates[0];
    nameConf = 0.55;
  }
  supplierName = supplierName.replace(/\s{2,}.*$/, '').slice(0, 120);
  conf['supplierName'] = supplierName ? nameConf : 0.1;

  // lines
  const lines: Line[] = [];
  const lineRows: number[] = [];
  let header: Header | null = null;
  let headerRow = -1;
  for (let i = 0; i < rows.length; i++) {
    const h = headerOf(rows[i]!);
    if (h) {
      header = h;
      headerRow = i;
      break;
    }
  }
  const start = headerRow + 1;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.trim()) continue;
    if (lines.length && TOTAL_LABELS.test(r) && !HEADER.test(r)) break;
    const l =
      (header && lineFromHeader(r, header)) || (!SKIP_ROW.test(r) ? lineFromShape(r) : null);
    if (l) {
      lines.push(l);
      lineRows.push(i);
    }
  }
  conf['lines'] = lines.length ? (header ? 0.75 : 0.5) : 0.1;

  // a GST rate from the tax summary when the lines carry none, and the summary names exactly one rate
  const rates = new Set<number>();
  for (const m of text.matchAll(/\bIGST\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%/gi)) rates.add(Number(m[1]));
  for (const m of text.matchAll(/\bCGST\s*@?\s*(\d{1,2}(?:\.\d+)?)\s*%/gi))
    rates.add(Number(m[1]) * 2);
  if (rates.size === 1) {
    const only = [...rates][0]!;
    for (const l of lines) if (!l.gstRateBp) l.gstRateBp = Math.round(only * 100);
  } else if (rates.size > 1) {
    // several rates on the bill: the HSN master says which line gets which; without it the rate stays unknown
    let unknown = 0;
    for (const l of lines) {
      if (l.gstRateBp) continue;
      const fromMaster = l.hsn && opts.rateForHsn ? opts.rateForHsn(l.hsn) : null;
      if (fromMaster !== null && fromMaster !== undefined && rates.has(fromMaster / 100))
        l.gstRateBp = fromMaster;
      else unknown++;
    }
    if (unknown) conf['lines'] = Math.min(conf['lines']!, 0.5);
  }

  // total: the last labelled total, else the largest amount in the text
  let totalPaise = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (TOTAL_LABELS.test(r) && !/\b(sub ?total|taxable)\b/i.test(r)) {
      const ns = (r.match(NUM) ?? []).map(toNumber).filter((n) => n > 0);
      if (ns.length) {
        totalPaise = paise(ns[ns.length - 1]!);
        conf['totalPaise'] = /grand|net|payable|invoice total/i.test(r) ? 0.9 : 0.7;
        break;
      }
    }
  }
  if (!totalPaise) {
    const all = (text.match(NUM) ?? []).map(toNumber).filter((n) => n > 0 && n < 1e9);
    if (all.length) {
      totalPaise = paise(Math.max(...all));
      conf['totalPaise'] = 0.4;
    } else conf['totalPaise'] = 0.1;
  }

  return {
    bill: {
      supplierName,
      supplierGstin,
      invoiceNumber,
      date: date || '1970-01-01',
      lines,
      totalPaise,
    },
    fieldConfidence: conf,
    lineRows,
  };
}

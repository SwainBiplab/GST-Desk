/** Checks before a return is exported. Errors block (the card shows a blocker count); warnings do not. */
import { checkGstin } from '../gstin';

import type { Gstr1, Gstr3b, GstrDoc, GstrIssue } from './types';

export interface GstrValidationContext {
  /** The business's own GSTIN. */
  gstin: string;
  scheme: 'regular' | 'composition';
  /** 4 for a business with turnover up to INR 5 crore, 6 above (the HSN digit rule, as data in settings). */
  minHsnDigits: number;
}

/** Document numbers in GST returns: up to 16 letters, digits, "/" or "-". */
const DOC_NUMBER = /^[A-Za-z0-9/-]{1,16}$/;

const OUTWARD = new Set(['tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note']);

export function validateGstr1(g: Gstr1, docs: GstrDoc[], ctx: GstrValidationContext): GstrIssue[] {
  const issues: GstrIssue[] = [...g.issues];
  const err = (code: string, table: string, message: string, docId?: string) =>
    issues.push({ severity: 'error', code, table, message, ...(docId ? { docId } : {}) });
  const warn = (code: string, table: string, message: string, docId?: string) =>
    issues.push({ severity: 'warning', code, table, message, ...(docId ? { docId } : {}) });

  if (ctx.scheme === 'composition') {
    err(
      'composition_no_gstr1',
      '-',
      'A composition business does not file GSTR-1 (it files CMP-08 and GSTR-4, which GST Desk does not produce yet)',
    );
  }
  const own = checkGstin(ctx.gstin);
  if (!own.valid)
    err(
      'own_gstin_invalid',
      '-',
      'The business GSTIN is missing or not valid (Settings, Business)',
    );

  const inPeriod = docs.filter((d) => d.date >= g.period.from && d.date <= g.period.to);
  for (const d of inPeriod) {
    if (d.status !== 'issued' || !OUTWARD.has(d.type)) continue;
    if (!DOC_NUMBER.test(d.number)) {
      err(
        'document_number_format',
        '4',
        `${d.number}: GSTN accepts up to 16 letters, digits, "/" and "-" in a document number`,
        d.id,
      );
    }
    if (!d.pos) err('missing_pos', '4', `${d.number}: the place of supply is missing`, d.id);
    if (d.registered || d.supplyType === 'sez') {
      const c = checkGstin(d.partyGstin);
      if (d.partyGstin && !c.valid) {
        err(
          'recipient_gstin_invalid',
          '4',
          `${d.number}: recipient GSTIN ${d.partyGstin} is not valid`,
          d.id,
        );
      }
    }
    for (const l of d.lines) {
      if (l.taxablePaise < 0) {
        err('negative_value', '4', `${d.number}: a line has a negative taxable value`, d.id);
        break;
      }
    }
    for (const l of d.lines) {
      if (l.taxability === 'non_gst') continue;
      if (!l.hsn) {
        err('missing_hsn', '12', `${d.number}: a line has no HSN or SAC code`, d.id);
        break;
      }
      if (l.hsn.length < ctx.minHsnDigits) {
        warn(
          'hsn_too_short',
          '12',
          `${d.number}: HSN ${l.hsn} has ${l.hsn.length} digits and this business should report at least ${ctx.minHsnDigits}`,
          d.id,
        );
        break;
      }
    }
  }

  // cross-table totals: every taxable rupee in tables 4 to 9 must equal what the builder counted
  const sumRows = (rows: { txval: number; rateBp: number }[]) =>
    rows.reduce((a, r) => a + r.txval, 0);
  const inv = (ps: { invoices: { items: { txval: number; rateBp: number }[] }[] }[]) =>
    ps.reduce((a, p) => a + p.invoices.reduce((b, i) => b + sumRows(i.items), 0), 0);
  const notes = g.cdnr.reduce(
    (a, p) => a + p.notes.reduce((b, n) => b + (n.ntty === 'C' ? -1 : 1) * sumRows(n.items), 0),
    0,
  );
  const urNotes = g.cdnur.reduce((a, n) => a + (n.ntty === 'C' ? -1 : 1) * sumRows(n.items), 0);
  const tableTotal = inv(g.b2b) + inv(g.b2cl) + sumRows(g.b2cs) + notes + urNotes + inv(g.exp);
  const missingGstin = issues.some((i) => i.code === 'missing_recipient_gstin');
  if (!missingGstin && tableTotal !== g.totals.txval) {
    err(
      'table_total_mismatch',
      '-',
      `Tables 4 to 9 add up to ${tableTotal / 100} but the documents carry ${g.totals.txval / 100} of taxable value`,
    );
  }
  const hsnTotal =
    g.hsnB2b.reduce((a, h) => a + h.txval, 0) + g.hsnB2c.reduce((a, h) => a + h.txval, 0);
  const nilNotNonGst = g.nil.reduce((a, r) => a + r.exptAmt + r.nilAmt, 0);
  if (g.unplacedPaise === 0 && hsnTotal !== g.totals.txval + nilNotNonGst) {
    warn(
      'hsn_total_mismatch',
      '12',
      `The HSN summary adds up to ${hsnTotal / 100}, which differs from the taxable (${g.totals.txval / 100}) and exempt or nil-rated (${nilNotNonGst / 100}) values of tables 4 to 8`,
    );
  }
  return issues;
}

/** Table 3.1 of GSTR-3B must agree with GSTR-1 on outward values for the same period. */
export function crossCheck(g1: Gstr1, g3b: Gstr3b): GstrIssue[] {
  const issues: GstrIssue[] = [];
  const out1 = g1.totals.txval;
  const out3 = g3b.s31.a.txval + g3b.s31.b.txval;
  if (out1 !== out3) {
    issues.push({
      severity: 'error',
      code: 'gstr1_3b_taxable_mismatch',
      table: '3.1',
      message: `GSTR-1 shows ${out1 / 100} of taxable outward supplies and GSTR-3B table 3.1 shows ${out3 / 100}`,
    });
  }
  const tax1 = g1.totals.iamt + g1.totals.camt + g1.totals.samt + g1.totals.csamt;
  const tax3 =
    g3b.s31.a.iamt +
    g3b.s31.a.camt +
    g3b.s31.a.samt +
    g3b.s31.a.csamt +
    g3b.s31.b.iamt +
    g3b.s31.b.csamt;
  if (tax1 !== tax3) {
    issues.push({
      severity: 'error',
      code: 'gstr1_3b_tax_mismatch',
      table: '3.1',
      message: `GSTR-1 shows ${tax1 / 100} of tax on outward supplies and GSTR-3B table 3.1 shows ${tax3 / 100}`,
    });
  }
  return issues;
}

export const blockers = (issues: GstrIssue[]): number =>
  issues.filter((i) => i.severity === 'error').length;

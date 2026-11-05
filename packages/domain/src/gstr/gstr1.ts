/**
 * GSTR-1 tables from issued documents. Pure: documents in, typed tables out. The government's file
 * layout is applied afterwards by `json.ts` using the stored schema version, so a new layout never
 * touches this file.
 */
import { GSTN_V1, type GstnSchema } from '../../data/gstn-schemas/v1';

import type {
  B2bInvoice,
  B2bParty,
  B2cl,
  B2csRow,
  CdnrParty,
  CdnurRow,
  DocRange,
  ExpGroup,
  Gstr1,
  GstrDoc,
  GstrIssue,
  GstrLine,
  GstrPeriod,
  GstrHsnRow,
  NilRow,
  NoteRow,
  RateRow,
  TaxAmounts,
} from './types';

const OUTWARD_INVOICES = new Set(['tax_invoice', 'bill_of_supply']);
const OUTWARD_NOTES = new Set(['credit_note', 'debit_note']);

const lineTax = (l: GstrLine): TaxAmounts => ({
  txval: l.taxablePaise,
  iamt: l.igstPaise,
  camt: l.cgstPaise,
  samt: l.sgstPaise,
  csamt: l.cessPaise,
});

function addTax(a: TaxAmounts, b: TaxAmounts, sign: 1 | -1 = 1): TaxAmounts {
  return {
    txval: a.txval + sign * b.txval,
    iamt: a.iamt + sign * b.iamt,
    camt: a.camt + sign * b.camt,
    samt: a.samt + sign * b.samt,
    csamt: a.csamt + sign * b.csamt,
  };
}

const zero = (): TaxAmounts => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });

/** Taxable lines grouped by rate, in rate order. */
export function rateRows(lines: GstrLine[]): RateRow[] {
  const by = new Map<number, RateRow>();
  for (const l of lines) {
    if (l.taxability !== 'taxable') continue;
    const cur = by.get(l.rateBp) ?? { rateBp: l.rateBp, ...zero() };
    by.set(l.rateBp, { rateBp: l.rateBp, ...addTax(cur, lineTax(l)) });
  }
  return [...by.values()].sort((a, b) => a.rateBp - b.rateBp);
}

const hasTaxable = (d: GstrDoc): boolean => d.lines.some((l) => l.taxability === 'taxable');

function invTyp(d: GstrDoc, s: GstnSchema): string {
  if (d.supplyType === 'sez')
    return d.lut ? s.invoiceTypes.sezWithoutPay : s.invoiceTypes.sezWithPay;
  return s.invoiceTypes.regular;
}

/** The numeric tail of a document number, used to find gaps in a series. */
export function numberTail(n: string): number | null {
  const m = /(\d+)\D*$/.exec(n);
  return m ? Number(m[1]) : null;
}

export function buildGstr1(
  period: GstrPeriod,
  docs: GstrDoc[],
  schema: GstnSchema = GSTN_V1,
): Gstr1 {
  const issues: GstrIssue[] = [];
  const inPeriod = docs.filter((d) => d.date >= period.from && d.date <= period.to);
  const issued = inPeriod.filter((d) => d.status === 'issued');

  const b2b = new Map<string, B2bParty>();
  const b2cl = new Map<string, B2cl>();
  const b2cs = new Map<string, B2csRow>();
  const cdnr = new Map<string, CdnrParty>();
  const cdnur: CdnurRow[] = [];
  const exp = new Map<string, ExpGroup>();
  const nil = new Map<string, NilRow>();
  const hsn = { b2b: new Map<string, GstrHsnRow>(), b2c: new Map<string, GstrHsnRow>() };
  let totals = zero();
  let nilTotal = 0;
  let unplaced = 0;

  const addB2cs = (pos: string, rows: RateRow[], sign: 1 | -1) => {
    for (const r of rows) {
      const key = `${pos}|${r.rateBp}`;
      const cur = b2cs.get(key) ?? { pos, rateBp: r.rateBp, ...zero() };
      b2cs.set(key, { pos, rateBp: r.rateBp, ...addTax(cur, r, sign) });
    }
  };

  for (const d of issued) {
    const outward = OUTWARD_INVOICES.has(d.type) || OUTWARD_NOTES.has(d.type);
    if (!outward) continue;
    const isNote = OUTWARD_NOTES.has(d.type);
    const isCredit = d.type === 'credit_note';
    const sign: 1 | -1 = isCredit ? -1 : 1;
    const items = rateRows(d.lines);

    // table 8 and table 12 look at every line
    for (const l of d.lines) {
      if (l.taxability !== 'taxable') {
        const domestic = d.supplyType === 'intra' || d.supplyType === 'inter';
        if (!domestic) {
          unplaced += sign * l.taxablePaise;
          issues.push({
            severity: 'warning',
            code: 'nil_line_not_reportable',
            table: '8',
            docId: d.id,
            message: `${d.number}: a nil-rated, exempt or non-GST line of an export or SEZ supply has no table in GSTR-1`,
          });
        } else {
          const inter = d.supplyType === 'inter';
          const key = d.registered
            ? inter
              ? schema.nilTypes.interB2B
              : schema.nilTypes.intraB2B
            : inter
              ? schema.nilTypes.interB2C
              : schema.nilTypes.intraB2C;
          const cur = nil.get(key) ?? { splyTy: key, exptAmt: 0, nilAmt: 0, ngsupAmt: 0 };
          const v = sign * l.taxablePaise;
          if (l.taxability === 'exempt') cur.exptAmt += v;
          else if (l.taxability === 'nil_rated') cur.nilAmt += v;
          else cur.ngsupAmt += v;
          nil.set(key, cur);
          nilTotal += v;
        }
      }
      if (l.taxability !== 'non_gst') {
        const bucket = d.registered ? hsn.b2b : hsn.b2c;
        const key = `${l.hsn}|${l.uqc}|${l.rateBp}`;
        const cur = bucket.get(key) ?? {
          hsn: l.hsn,
          description: l.description,
          uqc: l.uqc,
          qtyMicros: 0,
          val: 0,
          rateBp: l.rateBp,
          txval: 0,
          iamt: 0,
          camt: 0,
          samt: 0,
          csamt: 0,
        };
        cur.qtyMicros += sign * l.qtyMicros;
        cur.val += sign * (l.taxablePaise + l.igstPaise + l.cgstPaise + l.sgstPaise + l.cessPaise);
        cur.txval += sign * l.taxablePaise;
        cur.iamt += sign * l.igstPaise;
        cur.camt += sign * l.cgstPaise;
        cur.samt += sign * l.sgstPaise;
        cur.csamt += sign * l.cessPaise;
        bucket.set(key, cur);
      }
    }

    if (!hasTaxable(d)) continue;
    const taxableSum = items.reduce((a, r) => addTax(a, r), zero());
    totals = addTax(totals, taxableSum, sign);

    // exports
    if (d.supplyType === 'export') {
      if (isNote) {
        cdnur.push({
          docId: d.id,
          typ: d.lut ? schema.urTypes.exportWithoutPay : schema.urTypes.exportWithPay,
          ntty: isCredit ? (schema.noteTypes.credit as 'C') : (schema.noteTypes.debit as 'D'),
          num: d.number,
          dt: d.date,
          val: d.totalPaise,
          pos: d.pos,
          items,
        });
      } else {
        const expTyp = d.lut ? schema.exportTypes.withoutPay : schema.exportTypes.withPay;
        const g = exp.get(expTyp) ?? { expTyp, invoices: [] };
        g.invoices.push({ docId: d.id, inum: d.number, idt: d.date, val: d.totalPaise, items });
        exp.set(expTyp, g);
      }
      continue;
    }

    // registered recipients (and SEZ units)
    if (d.registered || d.supplyType === 'sez') {
      if (!d.partyGstin) {
        issues.push({
          severity: 'error',
          code: 'missing_recipient_gstin',
          table: isNote ? '9B' : '4',
          docId: d.id,
          message: `${d.number}: a supply to a registered person or SEZ unit has no recipient GSTIN`,
        });
        continue;
      }
      const type = invTyp(d, schema);
      if (isNote) {
        const p = cdnr.get(d.partyGstin) ?? { ctin: d.partyGstin, name: d.partyName, notes: [] };
        const note: NoteRow = {
          docId: d.id,
          ntty: isCredit ? 'C' : 'D',
          num: d.number,
          dt: d.date,
          val: d.totalPaise,
          pos: d.pos,
          rchrg: d.reverseCharge,
          invTyp: type,
          linked: d.linkedNumber,
          items,
        };
        p.notes.push(note);
        cdnr.set(d.partyGstin, p);
      } else {
        const p = b2b.get(d.partyGstin) ?? { ctin: d.partyGstin, name: d.partyName, invoices: [] };
        const inv: B2bInvoice = {
          docId: d.id,
          inum: d.number,
          idt: d.date,
          val: d.totalPaise,
          pos: d.pos,
          rchrg: d.reverseCharge,
          invTyp: type,
          items,
        };
        p.invoices.push(inv);
        b2b.set(d.partyGstin, p);
      }
      continue;
    }

    // unregistered recipients
    const inter = d.supplyType === 'inter';
    if (!isNote) {
      if (inter && d.totalPaise > schema.b2clLimitPaise) {
        const g = b2cl.get(d.pos) ?? { pos: d.pos, invoices: [] };
        g.invoices.push({ docId: d.id, inum: d.number, idt: d.date, val: d.totalPaise, items });
        b2cl.set(d.pos, g);
      } else {
        addB2cs(d.pos, items, 1);
      }
      continue;
    }
    // a note to an unregistered recipient
    const basis = d.linkedTotalPaise > 0 ? d.linkedTotalPaise : d.totalPaise;
    if (d.linkedTotalPaise === 0) {
      issues.push({
        severity: 'warning',
        code: 'note_without_invoice',
        table: '9B',
        docId: d.id,
        message: `${d.number}: the note is not linked to an invoice, so its own value decides whether it is a B2CL note`,
      });
    }
    if (inter && basis > schema.b2clLimitPaise) {
      cdnur.push({
        docId: d.id,
        typ: schema.urTypes.b2cl,
        ntty: isCredit ? 'C' : 'D',
        num: d.number,
        dt: d.date,
        val: d.totalPaise,
        pos: d.pos,
        items,
      });
    } else {
      // small or intra-state notes to consumers adjust the consumer summary
      addB2cs(d.pos, items, sign);
    }
  }

  // table 13: documents issued, by nature and series (cancelled ones counted, not hidden)
  const natureOf = (t: string): string | null =>
    t === 'tax_invoice' || t === 'bill_of_supply'
      ? 'invoice'
      : t === 'debit_note'
        ? 'debit_note'
        : t === 'credit_note'
          ? 'credit_note'
          : t === 'receipt_voucher'
            ? 'receipt_voucher'
            : null;
  const groups = new Map<string, { nature: string; docs: GstrDoc[] }>();
  for (const d of inPeriod) {
    const nature = natureOf(d.type);
    if (!nature || !d.number) continue;
    const key = `${nature}|${d.seriesKey}`;
    const g = groups.get(key) ?? { nature, docs: [] };
    g.docs.push(d);
    groups.set(key, g);
  }
  const ranges: DocRange[] = [];
  for (const g of groups.values()) {
    const sorted = [...g.docs].sort(
      (a, b) =>
        (numberTail(a.number) ?? 0) - (numberTail(b.number) ?? 0) ||
        a.number.localeCompare(b.number),
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!first || !last) continue;
    const cancel = sorted.filter((d) => d.status === 'cancelled').length;
    const meta = schema.docNature[g.nature];
    ranges.push({
      docNum: meta?.code ?? 12,
      docTyp: meta?.label ?? 'Others',
      from: first.number,
      to: last.number,
      totnum: sorted.length,
      cancel,
      netIssue: sorted.length - cancel,
    });
    // a gap means a number was skipped, which the numbering rules should not allow
    const a = numberTail(first.number);
    const z = numberTail(last.number);
    if (a !== null && z !== null && z - a + 1 !== sorted.length) {
      issues.push({
        severity: 'warning',
        code: 'series_gap',
        table: '13',
        message: `${first.number} to ${last.number}: ${sorted.length} documents in a range of ${z - a + 1}; a number may be missing from this period`,
      });
    }
  }
  ranges.sort((a, b) => a.docNum - b.docNum || a.from.localeCompare(b.from));

  const sortHsn = (m: Map<string, GstrHsnRow>): GstrHsnRow[] =>
    [...m.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rateBp - b.rateBp);

  return {
    period,
    b2b: [...b2b.values()].sort((a, b) => a.ctin.localeCompare(b.ctin)),
    b2cl: [...b2cl.values()].sort((a, b) => a.pos.localeCompare(b.pos)),
    b2cs: [...b2cs.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rateBp - b.rateBp),
    cdnr: [...cdnr.values()].sort((a, b) => a.ctin.localeCompare(b.ctin)),
    cdnur,
    exp: [...exp.values()].sort((a, b) => a.expTyp.localeCompare(b.expTyp)),
    nil: [...nil.values()].sort((a, b) => a.splyTy.localeCompare(b.splyTy)),
    hsnB2b: sortHsn(hsn.b2b),
    hsnB2c: sortHsn(hsn.b2c),
    docs: ranges,
    totals,
    nilTotalPaise: nilTotal,
    unplacedPaise: unplaced,
    issues,
  };
}

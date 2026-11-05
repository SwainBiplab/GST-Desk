/**
 * The GSTN offline-tool file layout. This is the only place that knows the government's key names; the
 * table builders output typed objects and the stored schema version (`data/gstn-schemas`) supplies the
 * codes and limits. See `data/gstn-schemas/README.md` before changing anything here, and note that the
 * layout has NOT been verified against the real offline tool yet.
 */
import { GSTN_V1, type GstnSchema } from '../../data/gstn-schemas/v1';
import { divRound, toDecimalString } from '../money';

import { gstnDate } from './period';
import type { Gstr1, Gstr3b, GstrHsnRow, RateRow, Tax4, TaxAmounts } from './types';

export const SCHEMAS: Record<string, GstnSchema> = { v1: GSTN_V1 };
export const DEFAULT_SCHEMA = GSTN_V1;

type Json = Record<string, unknown>;

/**
 * Amounts for the file. The files carry decimal numbers, so each value is written as an exact decimal
 * string by integer arithmetic and only then read as a JSON number: money never goes through float math.
 */
export const paiseToRupees = (p: number): number => Number(toDecimalString(BigInt(p), 2));
const pct = (bp: number): number => Number(toDecimalString(BigInt(bp), 2));
const qty = (micros: number): number => Number(toDecimalString(divRound(BigInt(micros), 1000n), 3));

/** `num` of an item row: the rate and a serial, as the offline tool writes it (for example 1801 for 18%). */
const itemNum = (rateBp: number): number => Math.round(rateBp / 100) * 100 + 1;

/** The tax fields of a row: the heads that carry tax, and the cess. */
function taxFields(r: TaxAmounts): Json {
  const out: Json = { txval: paiseToRupees(r.txval) };
  const inter = r.iamt !== 0;
  const intra = r.camt !== 0 || r.samt !== 0;
  if (inter || !intra) out['iamt'] = paiseToRupees(r.iamt);
  if (intra) {
    out['camt'] = paiseToRupees(r.camt);
    out['samt'] = paiseToRupees(r.samt);
  }
  out['csamt'] = paiseToRupees(r.csamt);
  return out;
}

const items = (rows: RateRow[]): Json[] =>
  rows.map((r) => ({ num: itemNum(r.rateBp), itm_det: { rt: pct(r.rateBp), ...taxFields(r) } }));

const yn = (b: boolean): string => (b ? 'Y' : 'N');

function hsnJson(rows: GstrHsnRow[]): Json[] {
  return rows.map((h, i) => ({
    num: i + 1,
    hsn_sc: h.hsn,
    desc: h.description,
    uqc: h.uqc,
    qty: qty(h.qtyMicros),
    rt: pct(h.rateBp),
    val: paiseToRupees(h.val),
    txval: paiseToRupees(h.txval),
    iamt: paiseToRupees(h.iamt),
    camt: paiseToRupees(h.camt),
    samt: paiseToRupees(h.samt),
    csamt: paiseToRupees(h.csamt),
  }));
}

export function gstr1Json(g: Gstr1, schema: GstnSchema = DEFAULT_SCHEMA): Json {
  const supplierState = g.period.gstin.slice(0, 2);
  const out: Json = { gstin: g.period.gstin, fp: g.period.fp };
  if (g.b2b.length) {
    out['b2b'] = g.b2b.map((p) => ({
      ctin: p.ctin,
      inv: p.invoices.map((i) => ({
        inum: i.inum,
        idt: gstnDate(i.idt),
        val: paiseToRupees(i.val),
        pos: i.pos,
        rchrg: yn(i.rchrg),
        inv_typ: i.invTyp,
        itms: items(i.items),
      })),
    }));
  }
  if (g.b2cl.length) {
    out['b2cl'] = g.b2cl.map((p) => ({
      pos: p.pos,
      inv: p.invoices.map((i) => ({
        inum: i.inum,
        idt: gstnDate(i.idt),
        val: paiseToRupees(i.val),
        itms: items(i.items),
      })),
    }));
  }
  if (g.b2cs.length) {
    out['b2cs'] = g.b2cs.map((r) => ({
      sply_ty: r.pos === supplierState ? 'INTRA' : 'INTER',
      pos: r.pos,
      typ: 'OE',
      rt: pct(r.rateBp),
      ...taxFields(r),
    }));
  }
  if (g.cdnr.length) {
    out['cdnr'] = g.cdnr.map((p) => ({
      ctin: p.ctin,
      nt: p.notes.map((n) => ({
        ntty: n.ntty,
        nt_num: n.num,
        nt_dt: gstnDate(n.dt),
        val: paiseToRupees(n.val),
        pos: n.pos,
        rchrg: yn(n.rchrg),
        inv_typ: n.invTyp,
        itms: items(n.items),
      })),
    }));
  }
  if (g.cdnur.length) {
    out['cdnur'] = g.cdnur.map((n) => ({
      typ: n.typ,
      ntty: n.ntty,
      nt_num: n.num,
      nt_dt: gstnDate(n.dt),
      val: paiseToRupees(n.val),
      pos: n.pos,
      itms: items(n.items),
    }));
  }
  if (g.exp.length) {
    out['exp'] = g.exp.map((x) => ({
      exp_typ: x.expTyp,
      inv: x.invoices.map((i) => ({
        inum: i.inum,
        idt: gstnDate(i.idt),
        val: paiseToRupees(i.val),
        itms: i.items.map((r) => ({
          rt: pct(r.rateBp),
          txval: paiseToRupees(r.txval),
          iamt: paiseToRupees(r.iamt),
          csamt: paiseToRupees(r.csamt),
        })),
      })),
    }));
  }
  if (g.nil.length) {
    out['nil'] = {
      inv: g.nil.map((n) => ({
        sply_ty: n.splyTy,
        expt_amt: paiseToRupees(n.exptAmt),
        nil_amt: paiseToRupees(n.nilAmt),
        ngsup_amt: paiseToRupees(n.ngsupAmt),
      })),
    };
  }
  if (g.hsnB2b.length || g.hsnB2c.length) {
    out['hsn'] = { hsn_b2b: hsnJson(g.hsnB2b), hsn_b2c: hsnJson(g.hsnB2c) };
  }
  if (g.docs.length) {
    // one entry per nature, with each series of that nature inside it
    const byNature = new Map<number, { doc_num: number; doc_typ: string; docs: Json[] }>();
    for (const r of g.docs) {
      const e = byNature.get(r.docNum) ?? { doc_num: r.docNum, doc_typ: r.docTyp, docs: [] };
      e.docs.push({
        num: e.docs.length + 1,
        from: r.from,
        to: r.to,
        totnum: r.totnum,
        cancel: r.cancel,
        net_issue: r.netIssue,
      });
      byNature.set(r.docNum, e);
    }
    out['doc_issue'] = { doc_det: [...byNature.values()] };
  }
  void schema;
  return out;
}

const t4 = (t: Tax4): Json => ({
  iamt: paiseToRupees(t.iamt),
  camt: paiseToRupees(t.camt),
  samt: paiseToRupees(t.samt),
  csamt: paiseToRupees(t.csamt),
});
const detail = (a: TaxAmounts): Json => ({ txval: paiseToRupees(a.txval), ...t4(a) });

export function gstr3bJson(g: Gstr3b, schema: GstnSchema = DEFAULT_SCHEMA): Json {
  void schema;
  const s4 = g.s4;
  return {
    gstin: g.period.gstin,
    ret_period: g.period.fp,
    sup_details: {
      osup_det: detail(g.s31.a),
      osup_zero: {
        txval: paiseToRupees(g.s31.b.txval),
        iamt: paiseToRupees(g.s31.b.iamt),
        csamt: paiseToRupees(g.s31.b.csamt),
      },
      osup_nil_exmp: { txval: paiseToRupees(g.s31.c.txval) },
      isup_rev: detail(g.s31.d),
      osup_nongst: { txval: paiseToRupees(g.s31.e.txval) },
    },
    inter_sup: {
      unreg_details: g.s32.unreg.map((r) => ({
        pos: r.pos,
        txval: paiseToRupees(r.txval),
        iamt: paiseToRupees(r.iamt),
      })),
      comp_details: g.s32.composition.map((r) => ({
        pos: r.pos,
        txval: paiseToRupees(r.txval),
        iamt: paiseToRupees(r.iamt),
      })),
      uin_details: [],
    },
    itc_elg: {
      itc_avl: [
        { ty: 'IMPG', ...t4(s4.availableImportGoods) },
        { ty: 'IMPS', ...t4(s4.availableImportServices) },
        { ty: 'ISRC', ...t4(s4.availableReverseCharge) },
        { ty: 'ISD', ...t4(s4.availableIsd) },
        { ty: 'OTH', ...t4(s4.availableOther) },
      ],
      itc_rev: [
        { ty: 'RUL', ...t4(s4.reversedRules) },
        { ty: 'OTH', ...t4(s4.reversedOther) },
      ],
      itc_net: t4(s4.net),
      itc_inelg: [
        { ty: 'RUL', ...t4(s4.ineligibleRules) },
        { ty: 'OTH', ...t4(s4.ineligibleOther) },
      ],
    },
    inward_sup: {
      isup_details: [
        { ty: 'GST', inter: paiseToRupees(g.s5.gst.inter), intra: paiseToRupees(g.s5.gst.intra) },
        {
          ty: 'NONGST',
          inter: paiseToRupees(g.s5.nonGst.inter),
          intra: paiseToRupees(g.s5.nonGst.intra),
        },
      ],
    },
  };
}

/* ---------------------------------------------------------------- structural check */

const DATE = /^\d{2}-\d{2}-\d{4}$/;
const FP = /^\d{6}$/;

/** What is wrong with a generated file, by the stored layout. Empty means it matches. */
export function checkGstr1Json(file: Json, schema: GstnSchema = DEFAULT_SCHEMA): string[] {
  const problems: string[] = [];
  const known = new Set([...schema.gstr1Keys.required, ...schema.gstr1Keys.optional]);
  for (const k of schema.gstr1Keys.required) if (!(k in file)) problems.push(`missing key ${k}`);
  for (const k of Object.keys(file)) if (!known.has(k)) problems.push(`unknown key ${k}`);
  if (typeof file['fp'] !== 'string' || !FP.test(file['fp'])) problems.push('fp must be MMYYYY');
  const typs = new Set(Object.values(schema.invoiceTypes));
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'number' && !Number.isFinite(v)) problems.push(`${path}: not a finite number`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'idt' || k === 'nt_dt') && !(typeof x === 'string' && DATE.test(x)))
          problems.push(`${path}.${k}: date must be DD-MM-YYYY`);
        if (k === 'inv_typ' && !(typeof x === 'string' && typs.has(x)))
          problems.push(`${path}.${k}: unknown invoice type ${String(x)}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(file, '$');
  return problems;
}

export function checkGstr3bJson(file: Json, schema: GstnSchema = DEFAULT_SCHEMA): string[] {
  const problems: string[] = [];
  const known = new Set([...schema.gstr3bKeys.required, ...schema.gstr3bKeys.optional]);
  for (const k of schema.gstr3bKeys.required) if (!(k in file)) problems.push(`missing key ${k}`);
  for (const k of Object.keys(file)) if (!known.has(k)) problems.push(`unknown key ${k}`);
  if (typeof file['ret_period'] !== 'string' || !FP.test(file['ret_period']))
    problems.push('ret_period must be MMYYYY');
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'number' && !Number.isFinite(v)) problems.push(`${path}: not a finite number`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(file, '$');
  return problems;
}

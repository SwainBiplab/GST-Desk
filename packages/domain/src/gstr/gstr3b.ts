/**
 * GSTR-3B from issued documents, purchase bills and any ITC adjustments a person made.
 *
 * Rules this applies (stated so a reviewer can check them):
 * - Table 3.1(a): taxable outward supplies other than exports and SEZ; (b) exports and SEZ supplies;
 *   (c) nil-rated and exempt lines; (e) non-GST lines. Credit notes subtract, debit notes add.
 * - Table 3.1(d) and 4A(3): purchase bills marked reverse charge, net of purchase returns. The recipient's
 *   own `rcm_self_invoice` is a mirror of the same bill and is not counted again.
 * - Table 4A(5): tax on the other purchase bills, net of purchase returns, treated as eligible unless a
 *   person records a reversal or an ineligible amount as an adjustment (no per-bill ITC flag exists yet).
 * - Table 6.1: an estimate. Reverse-charge tax can only be paid in cash; the rest is set off with credit
 *   in the statutory order (IGST credit against IGST, CGST, SGST; CGST credit against CGST, IGST; SGST
 *   credit against SGST, IGST; cess only against cess).
 */
import type {
  Gstr3b,
  GstrDoc,
  GstrIssue,
  GstrLine,
  GstrPeriod,
  PaymentEstimate,
  PeriodAdjustment,
  Tax4,
  TaxAmounts,
} from './types';

const zero = (): TaxAmounts => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
const zero4 = (): Tax4 => ({ iamt: 0, camt: 0, samt: 0, csamt: 0 });

function add(a: TaxAmounts, l: GstrLine, sign: 1 | -1): TaxAmounts {
  return {
    txval: a.txval + sign * l.taxablePaise,
    iamt: a.iamt + sign * l.igstPaise,
    camt: a.camt + sign * l.cgstPaise,
    samt: a.samt + sign * l.sgstPaise,
    csamt: a.csamt + sign * l.cessPaise,
  };
}

function add4(a: Tax4, l: GstrLine, sign: 1 | -1): Tax4 {
  return {
    iamt: a.iamt + sign * l.igstPaise,
    camt: a.camt + sign * l.cgstPaise,
    samt: a.samt + sign * l.sgstPaise,
    csamt: a.csamt + sign * l.cessPaise,
  };
}

const plus4 = (a: Tax4, b: Tax4): Tax4 => ({
  iamt: a.iamt + b.iamt,
  camt: a.camt + b.camt,
  samt: a.samt + b.samt,
  csamt: a.csamt + b.csamt,
});
const minus4 = (a: Tax4, b: Tax4): Tax4 => ({
  iamt: a.iamt - b.iamt,
  camt: a.camt - b.camt,
  samt: a.samt - b.samt,
  csamt: a.csamt - b.csamt,
});

/** The fields a person may adjust, and the table they belong to. */
export const ITC_FIELDS = [
  'availableImportGoods',
  'availableImportServices',
  'availableReverseCharge',
  'availableIsd',
  'availableOther',
  'reversedRules',
  'reversedOther',
  'ineligibleRules',
  'ineligibleOther',
] as const;
export type ItcField = (typeof ITC_FIELDS)[number];

export function estimatePayment(forward: Tax4, rcm: Tax4, credit: Tax4): PaymentEstimate {
  const liab: Tax4 = {
    iamt: Math.max(0, forward.iamt),
    camt: Math.max(0, forward.camt),
    samt: Math.max(0, forward.samt),
    csamt: Math.max(0, forward.csamt),
  };
  const left = { ...liab };
  const cr = {
    iamt: Math.max(0, credit.iamt),
    camt: Math.max(0, credit.camt),
    samt: Math.max(0, credit.samt),
    csamt: Math.max(0, credit.csamt),
  };
  const used = zero4();
  const take = (from: 'iamt' | 'camt' | 'samt', against: 'iamt' | 'camt' | 'samt') => {
    const n = Math.min(cr[from], left[against]);
    cr[from] -= n;
    left[against] -= n;
    used[from] += n;
  };
  // IGST credit first, then CGST credit, then SGST credit
  take('iamt', 'iamt');
  take('iamt', 'camt');
  take('iamt', 'samt');
  take('camt', 'camt');
  take('camt', 'iamt');
  take('samt', 'samt');
  take('samt', 'iamt');
  const cessUsed = Math.min(cr.csamt, left.csamt);
  cr.csamt -= cessUsed;
  left.csamt -= cessUsed;
  used.csamt += cessUsed;
  return {
    liability: plus4(liab, {
      iamt: Math.max(0, rcm.iamt),
      camt: Math.max(0, rcm.camt),
      samt: Math.max(0, rcm.samt),
      csamt: Math.max(0, rcm.csamt),
    }),
    creditUsed: used,
    cashPayable: plus4(left, {
      iamt: Math.max(0, rcm.iamt),
      camt: Math.max(0, rcm.camt),
      samt: Math.max(0, rcm.samt),
      csamt: Math.max(0, rcm.csamt),
    }),
    creditCarried: cr,
  };
}

export function buildGstr3b(
  period: GstrPeriod,
  docs: GstrDoc[],
  adjustments: PeriodAdjustment[] = [],
): { gstr3b: Gstr3b; issues: GstrIssue[] } {
  const issues: GstrIssue[] = [];
  const issued = docs.filter(
    (d) => d.status === 'issued' && d.date >= period.from && d.date <= period.to,
  );

  let a = zero();
  let b = zero();
  let c = zero();
  let dd = zero();
  let e = zero();
  const unreg = new Map<string, { pos: string; txval: number; iamt: number }>();
  const comp = new Map<string, { pos: string; txval: number; iamt: number }>();
  let otherItc = zero4();
  let rcmItc = zero4();
  const s5 = { gst: { inter: 0, intra: 0 }, nonGst: { inter: 0, intra: 0 } };

  for (const d of issued) {
    const outward =
      d.type === 'tax_invoice' ||
      d.type === 'bill_of_supply' ||
      d.type === 'credit_note' ||
      d.type === 'debit_note';
    if (outward) {
      const sign: 1 | -1 = d.type === 'credit_note' ? -1 : 1;
      for (const l of d.lines) {
        if (l.taxability === 'non_gst') {
          e = add(e, l, sign);
        } else if (l.taxability !== 'taxable') {
          c = add(c, l, sign);
        } else if (d.supplyType === 'export' || d.supplyType === 'sez') {
          b = add(b, l, sign);
        } else {
          a = add(a, l, sign);
          if (d.supplyType === 'inter' && (!d.registered || d.partyComposition)) {
            const m = d.registered ? comp : unreg;
            const cur = m.get(d.pos) ?? { pos: d.pos, txval: 0, iamt: 0 };
            cur.txval += sign * l.taxablePaise;
            cur.iamt += sign * l.igstPaise;
            m.set(d.pos, cur);
          }
        }
      }
      continue;
    }
    if (d.type === 'purchase_bill' || d.type === 'purchase_return') {
      const sign: 1 | -1 = d.type === 'purchase_return' ? -1 : 1;
      for (const l of d.lines) {
        if (l.taxability !== 'taxable') {
          const inter = d.supplyType === 'inter';
          const bucket = l.taxability === 'non_gst' ? s5.nonGst : s5.gst;
          if (inter) bucket.inter += sign * l.taxablePaise;
          else bucket.intra += sign * l.taxablePaise;
          continue;
        }
        if (d.reverseCharge) {
          dd = add(dd, l, sign);
          rcmItc = add4(rcmItc, l, sign);
        } else {
          otherItc = add4(otherItc, l, sign);
        }
      }
    }
  }

  const row: Record<ItcField, Tax4> = {
    availableImportGoods: zero4(),
    availableImportServices: zero4(),
    availableReverseCharge: rcmItc,
    availableIsd: zero4(),
    availableOther: otherItc,
    reversedRules: zero4(),
    reversedOther: zero4(),
    ineligibleRules: zero4(),
    ineligibleOther: zero4(),
  };
  for (const adj of adjustments) {
    const f = adj.field.replace(/^itc\./, '') as ItcField;
    if (!(ITC_FIELDS as readonly string[]).includes(f)) {
      issues.push({
        severity: 'error',
        code: 'unknown_adjustment',
        table: '4',
        message: `An adjustment names a field that does not exist: ${adj.field}`,
      });
      continue;
    }
    row[f] = plus4(row[f], adj);
  }
  const available = [
    row.availableImportGoods,
    row.availableImportServices,
    row.availableReverseCharge,
    row.availableIsd,
    row.availableOther,
  ].reduce(plus4, zero4());
  const reversed = plus4(row.reversedRules, row.reversedOther);
  const net = minus4(available, reversed);

  const forward: Tax4 = {
    iamt: a.iamt + b.iamt,
    camt: a.camt,
    samt: a.samt,
    csamt: a.csamt + b.csamt,
  };
  const rcm: Tax4 = { iamt: dd.iamt, camt: dd.camt, samt: dd.samt, csamt: dd.csamt };
  // credit that can be used against forward tax: everything except the reverse-charge credit, which
  // is only claimable after the reverse-charge tax is paid in cash (the net ITC shows it).
  const creditForSetoff = minus4(net, row.availableReverseCharge);

  if (a.txval < 0 || b.txval < 0) {
    issues.push({
      severity: 'warning',
      code: 'negative_outward',
      table: '3.1',
      message: 'Credit notes exceed the supplies of this period in table 3.1',
    });
  }

  const g: Gstr3b = {
    period,
    s31: { a, b, c, d: dd, e },
    s32: {
      unreg: [...unreg.values()].sort((x, y) => x.pos.localeCompare(y.pos)),
      composition: [...comp.values()].sort((x, y) => x.pos.localeCompare(y.pos)),
    },
    s4: {
      availableImportGoods: row.availableImportGoods,
      availableImportServices: row.availableImportServices,
      availableReverseCharge: row.availableReverseCharge,
      availableIsd: row.availableIsd,
      availableOther: row.availableOther,
      reversedRules: row.reversedRules,
      reversedOther: row.reversedOther,
      net,
      ineligibleRules: row.ineligibleRules,
      ineligibleOther: row.ineligibleOther,
    },
    s5: s5,
    s61: estimatePayment(forward, rcm, creditForSetoff),
  };
  return { gstr3b: g, issues };
}

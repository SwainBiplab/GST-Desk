/**
 * The e-invoice JSON (schema 1.1) for a document, and the checks the portal applies, so a person sees
 * what is wrong before anything is sent. The layout is the portal's; the rules it is checked against are
 * data (`data/einvoice/rules-v1_1.ts`).
 */
import { EINVOICE_RULES_V1_1, type EinvoiceRules } from '../../data/einvoice/rules-v1_1';
import { checkGstin } from '../gstin';
import { divRound, toDecimalString } from '../money';

import type { EinvDoc, EinvLine, EinvParty, EinvProblem } from './types';

type Json = Record<string, unknown>;

/** Money for the file: exact decimal by integer arithmetic, then a JSON number. */
const r2 = (p: number): number => Number(toDecimalString(BigInt(p), 2));
const r3qty = (micros: number): number =>
  Number(toDecimalString(divRound(BigInt(micros), 1000n), 3));
const pct = (bp: number): number => Number(toDecimalString(BigInt(bp), 2));
/** DD/MM/YYYY, as the portal wants it. */
export const portalDate = (iso: string): string =>
  `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const opt = (v: string | undefined | null): string | undefined =>
  v && v.trim() ? v.trim() : undefined;

function party(p: EinvParty): Json {
  const out: Json = {
    Gstin: p.gstin,
    LglNm: p.legalName,
    Addr1: p.addr1,
    Loc: p.location,
    Pin: Number(p.pincode),
    Stcd: p.stateCode,
  };
  if (opt(p.tradeName)) out['TrdNm'] = opt(p.tradeName);
  if (opt(p.addr2)) out['Addr2'] = opt(p.addr2);
  if (opt(p.phone)) out['Ph'] = opt(p.phone)!.replace(/\D/g, '');
  if (opt(p.email)) out['Em'] = opt(p.email);
  return out;
}

const isService = (hsn: string): boolean => hsn.startsWith('99');

function item(l: EinvLine, i: number): Json {
  return {
    SlNo: String(i + 1),
    PrdDesc: l.description,
    IsServc: isService(l.hsn) ? 'Y' : 'N',
    HsnCd: l.hsn,
    Qty: r3qty(l.qtyMicros),
    Unit: l.uqc || 'OTH',
    UnitPrice: r2(l.unitPricePaise),
    TotAmt: r2(l.grossPaise),
    Discount: r2(l.discountPaise),
    AssAmt: r2(l.taxablePaise),
    GstRt: pct(l.gstRateBp),
    IgstAmt: r2(l.igstPaise),
    CgstAmt: r2(l.cgstPaise),
    SgstAmt: r2(l.sgstPaise),
    CesRt: pct(l.cessRateBp),
    CesAmt: r2(l.cessPaise),
    OthChrg: r2(l.otherChargesPaise),
    TotItemVal: r2(l.totalPaise),
  };
}

/** The schema 1.1 JSON for a document. Build it, then check it with `checkEinvoice`. */
export function buildEinvoice(d: EinvDoc, rules: EinvoiceRules = EINVOICE_RULES_V1_1): Json {
  const out: Json = {
    Version: rules.version,
    TranDtls: {
      TaxSch: 'GST',
      SupTyp: d.supply,
      RegRev: d.reverseCharge ? 'Y' : 'N',
      IgstOnIntra: 'N',
    },
    DocDtls: { Typ: d.kind, No: d.number, Dt: portalDate(d.date) },
    SellerDtls: party(d.seller),
    BuyerDtls: { ...party(d.buyer), Pos: d.buyer.pos },
    ItemList: d.lines.map(item),
    ValDtls: {
      AssVal: r2(d.totals.assessablePaise),
      CgstVal: r2(d.totals.cgstPaise),
      SgstVal: r2(d.totals.sgstPaise),
      IgstVal: r2(d.totals.igstPaise),
      CesVal: r2(d.totals.cessPaise),
      Discount: r2(d.totals.discountPaise),
      OthChrg: r2(d.totals.otherChargesPaise),
      RndOffAmt: r2(d.totals.roundOffPaise),
      TotInvVal: r2(d.totals.totalPaise),
    },
  };
  if (d.shipTo) out['ShipDtls'] = party(d.shipTo);
  if (d.preceding)
    out['RefDtls'] = {
      PrecDocDtls: [{ InvNo: d.preceding.number, InvDt: portalDate(d.preceding.date) }],
    };
  if (d.exportDetails && d.supply.startsWith('EXP')) {
    const e = d.exportDetails;
    const exp: Json = {};
    if (opt(e.shippingBillNo)) exp['ShipBNo'] = opt(e.shippingBillNo);
    if (opt(e.shippingBillDate)) exp['ShipBDt'] = portalDate(e.shippingBillDate!);
    if (opt(e.portCode)) exp['Port'] = opt(e.portCode);
    if (opt(e.currency)) exp['ForCur'] = opt(e.currency);
    if (opt(e.countryCode)) exp['CntCode'] = opt(e.countryCode);
    out['ExpDtls'] = exp;
  }
  return out;
}

/**
 * The portal's checks, before sending: what would be refused, with where and why. Empty means it is
 * ready to send. `today` is YYYY-MM-DD in Asia/Kolkata; `turnoverPaise` is last year's aggregate turnover.
 */
export function checkEinvoice(
  d: EinvDoc,
  ctx: { today: string; turnoverPaise: number },
  rules: EinvoiceRules = EINVOICE_RULES_V1_1,
): EinvProblem[] {
  const out: EinvProblem[] = [];
  const add = (path: string, code: string, message: string) => out.push({ path, code, message });
  const exporting = d.supply === 'EXPWP' || d.supply === 'EXPWOP';

  if (!rules.docNumber.test(d.number))
    add(
      'DocDtls.No',
      'doc_number',
      `The number ${d.number} must be up to 16 letters, digits, "/" or "-", and must not start with 0, "/" or "-".`,
    );
  if (d.date > ctx.today)
    add('DocDtls.Dt', 'doc_date_future', 'The document is dated after today.');
  if (
    ctx.turnoverPaise >= rules.ageLimit.turnoverPaise &&
    ctx.today >= rules.ageLimit.from &&
    daysBetween(d.date, ctx.today) > rules.ageLimit.maxAgeDays
  )
    add(
      'DocDtls.Dt',
      'doc_too_old',
      `A business with turnover of INR 10 crore or more must report a document within ${rules.ageLimit.maxAgeDays} days; this one is older.`,
    );

  const checkParty = (p: EinvParty, path: string, buyerExport: boolean) => {
    if (!(buyerExport && p.gstin === 'URP') && !checkGstin(p.gstin).valid)
      add(`${path}.Gstin`, 'gstin', `${p.gstin || 'The GSTIN'} is not a valid GSTIN.`);
    const [lo, hi] = rules.lengths.legalName;
    if (p.legalName.trim().length < lo || p.legalName.length > hi)
      add(`${path}.LglNm`, 'legal_name', `The legal name must be ${lo} to ${hi} characters.`);
    if (!p.addr1.trim()) add(`${path}.Addr1`, 'address', 'The address is missing.');
    const [llo, lhi] = rules.lengths.location;
    if (p.location.trim().length < llo || p.location.length > lhi)
      add(
        `${path}.Loc`,
        'location',
        `The place (city or town) must be ${llo} to ${lhi} characters.`,
      );
    const pin = Number(p.pincode);
    if (buyerExport) {
      if (pin !== rules.pincode.export)
        add(
          `${path}.Pin`,
          'pincode',
          `For an export the buyer pincode is ${rules.pincode.export}.`,
        );
    } else if (!/^\d{6}$/.test(p.pincode) || pin < rules.pincode.min || pin > rules.pincode.max) {
      add(`${path}.Pin`, 'pincode', 'The pincode must be 6 digits.');
    }
  };
  checkParty(d.seller, 'SellerDtls', false);
  checkParty(d.buyer, 'BuyerDtls', exporting);
  if (exporting && d.buyer.pos !== '96')
    add('BuyerDtls.Pos', 'pos', 'For an export the place of supply is 96 (other country).');
  if (d.supply === 'B2B' && d.buyer.gstin === d.seller.gstin)
    add('BuyerDtls.Gstin', 'self', 'The buyer and the seller cannot have the same GSTIN.');

  if (d.lines.length === 0) add('ItemList', 'no_lines', 'There are no lines.');
  if (d.lines.length > rules.maxLines)
    add('ItemList', 'too_many_lines', `At most ${rules.maxLines} lines can be reported.`);
  const tol = rules.lineTolerancePaise;
  d.lines.forEach((l, i) => {
    const p = `ItemList[${i}]`;
    if (!/^\d{4}$|^\d{6}$|^\d{8}$/.test(l.hsn))
      add(`${p}.HsnCd`, 'hsn', `Line ${i + 1}: the HSN or SAC must be 4, 6 or 8 digits.`);
    else if (ctx.turnoverPaise > 5_00_00_000 * 100 && l.hsn.length < 6)
      add(
        `${p}.HsnCd`,
        'hsn_digits',
        `Line ${i + 1}: a business above INR 5 crore must report at least 6 HSN digits.`,
      );
    if (!rules.gstRatesBp.includes(l.gstRateBp))
      add(
        `${p}.GstRt`,
        'rate',
        `Line ${i + 1}: ${l.gstRateBp / 100}% is not a GST rate the portal accepts.`,
      );
    const [dlo, dhi] = rules.lengths.description;
    if (l.description.trim().length < dlo || l.description.length > dhi)
      add(
        `${p}.PrdDesc`,
        'description',
        `Line ${i + 1}: the description must be ${dlo} to ${dhi} characters.`,
      );
    if (Math.abs(l.grossPaise - l.discountPaise - l.taxablePaise) > tol)
      add(
        `${p}.AssAmt`,
        'assessable',
        `Line ${i + 1}: the taxable value is not the amount less the discount.`,
      );
    // integer arithmetic: the tax the rate gives, rounded to the paisa
    const expected = divRound(BigInt(l.taxablePaise) * BigInt(l.gstRateBp), 10_000n);
    const tax = l.igstPaise + l.cgstPaise + l.sgstPaise;
    const off = BigInt(tax) - expected;
    if (off > BigInt(tol) || off < -BigInt(tol))
      add(`${p}.GstRt`, 'tax', `Line ${i + 1}: the tax is not the taxable value times the rate.`);
    if (l.igstPaise !== 0 && (l.cgstPaise !== 0 || l.sgstPaise !== 0))
      add(
        `${p}.IgstAmt`,
        'heads',
        `Line ${i + 1}: a line carries either IGST or CGST and SGST, not both.`,
      );
    const sum = l.taxablePaise + tax + l.cessPaise + l.otherChargesPaise;
    if (Math.abs(sum - l.totalPaise) > tol)
      add(`${p}.TotItemVal`, 'line_total', `Line ${i + 1}: the line total does not add up.`);
  });
  const t = d.totals;
  const ass = d.lines.reduce((a, l) => a + l.taxablePaise, 0);
  if (Math.abs(ass - t.assessablePaise) > tol)
    add(
      'ValDtls.AssVal',
      'assessable_total',
      'The taxable value of the document is not the sum of its lines.',
    );
  if (Math.abs(t.roundOffPaise) > rules.maxRoundOffPaise)
    add('ValDtls.RndOffAmt', 'round_off', 'The round-off is more than INR 99.99.');
  const expectTotal =
    t.assessablePaise +
    t.cgstPaise +
    t.sgstPaise +
    t.igstPaise +
    t.cessPaise +
    t.otherChargesPaise -
    t.discountPaise +
    t.roundOffPaise;
  if (Math.abs(expectTotal - t.totalPaise) > tol)
    add('ValDtls.TotInvVal', 'total', 'The document total does not add up.');
  const inter = d.seller.stateCode !== d.buyer.pos;
  if (d.supply === 'B2B' && inter && (t.cgstPaise !== 0 || t.sgstPaise !== 0))
    add('ValDtls.CgstVal', 'inter_heads', 'An inter-state supply carries IGST, not CGST and SGST.');
  if (d.supply === 'B2B' && !inter && t.igstPaise !== 0)
    add('ValDtls.IgstVal', 'intra_heads', 'An intra-state supply carries CGST and SGST, not IGST.');
  if (
    (d.supply === 'SEZWOP' || d.supply === 'EXPWOP') &&
    t.igstPaise + t.cgstPaise + t.sgstPaise !== 0
  )
    add(
      'ValDtls.IgstVal',
      'without_payment',
      'A supply without payment of tax (under LUT) cannot carry tax.',
    );
  if ((d.kind === 'CRN' || d.kind === 'DBN') && !d.preceding)
    add('RefDtls', 'preceding', 'A credit or debit note should name the invoice it corrects.');
  return out;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Whether an IRN can still be cancelled (within the hours the portal allows after the acknowledgement). */
export function irnCancellable(
  ackDate: string,
  now: Date,
  rules: EinvoiceRules = EINVOICE_RULES_V1_1,
): boolean {
  // the portal's acknowledgement time is IST ("YYYY-MM-DD HH:mm:ss")
  const at = Date.parse(`${ackDate.replace(' ', 'T')}+05:30`);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at <= rules.cancelHours * 3_600_000;
}

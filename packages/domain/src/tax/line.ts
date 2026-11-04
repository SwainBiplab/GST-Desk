/**
 * Line-level pricing and GST computation.
 *
 * Rules: CGST Act s.15 (value of supply: discounts allowed before or at supply reduce the value),
 * s.8-9 (intra-state: CGST + SGST/UTGST), IGST Act s.5 (inter-state: IGST), Compensation Cess Act s.8
 * (ad valorem and specific cess), CGST s.9(3)/(4) (reverse charge), s.10 (composition: no tax collected).
 */
import { BP, MICROS, divRound, max, min } from '../money';
import { step, type TraceStep, type Traced } from '../trace';

import { taxHeadsFor, type PartyFlags, type SupplyType, type TaxHeads } from './supply';

export type Taxability = 'taxable' | 'exempt' | 'nil_rated' | 'non_gst';

export type DiscountInput =
  | { mode: 'none' }
  | { mode: 'percent'; bp: number }
  | { mode: 'per_unit'; perUnitPaise: bigint }
  /** Alias: the rate already includes tax, no discount. Equivalent to `pricing: 'inclusive'` + `none`. */
  | { mode: 'price_includes_tax' };

export interface LineInput {
  /** Quantity in micro-units (2.5 units = 2_500_000n). */
  qtyMicros: bigint;
  /** Rate per unit in paise. Tax-inclusive when `pricing` is `inclusive`. */
  ratePaise: bigint;
  discount: DiscountInput;
  pricing?: 'exclusive' | 'inclusive';
  /** Total GST rate in basis points (1800 = 18%). Split evenly between CGST and SGST/UTGST when intra-state. */
  gstRateBp: number;
  /** Ad valorem cess in basis points. */
  cessBp?: number;
  /** Specific cess in paise per unit. */
  cessPerUnitPaise?: bigint;
  taxability?: Taxability;
}

export interface LineContext {
  supply: SupplyType;
  supplierState: string;
  /** Export/SEZ supplied under LUT (no IGST charged). */
  lut?: boolean;
  /** Tax is computed but payable by the recipient; it is not added to the invoice total. */
  reverseCharge?: boolean;
  /** Supplier is under the composition scheme: no tax collected. */
  composition?: boolean;
}

export interface LineResult {
  grossPaise: bigint;
  discountPaise: bigint;
  /** Value on which tax is charged (after line discount, before document discount). */
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  utgstPaise: bigint;
  igstPaise: bigint;
  cessPaise: bigint;
  /** CGST + SGST + UTGST + IGST + cess, whether or not charged. */
  taxPaise: bigint;
  /** Tax payable by the recipient under reverse charge (zero otherwise). */
  rcmTaxPaise: bigint;
  /** Amount invoiced for this line: taxable + tax charged (tax excluded under RCM). */
  totalPaise: bigint;
  heads: TaxHeads;
  /** GST rate actually applied, in basis points (0 for exempt, composition, LUT...). */
  appliedRateBp: number;
  taxability: Taxability;
}

interface Effective {
  heads: TaxHeads;
  rateBp: bigint;
  cessBp: bigint;
  cessSpecificPaise: bigint;
  taxability: Taxability;
  why: string;
}

function effective(input: LineInput, ctx: LineContext): Effective {
  const taxability = input.taxability ?? 'taxable';
  const heads: TaxHeads = ctx.composition
    ? 'none'
    : taxHeadsFor(ctx.supply, ctx.supplierState, flagsOf(ctx));
  let why = '';
  if (ctx.composition) why = 'composition supplier: no tax collected (s.10)';
  else if (taxability !== 'taxable') why = `${taxability.replace('_', '-')} supply: no GST`;
  else if (heads === 'none') why = 'zero-rated under LUT: no tax charged';
  const zero = why !== '';
  return {
    heads,
    rateBp: zero ? 0n : BigInt(input.gstRateBp),
    cessBp: zero ? 0n : BigInt(input.cessBp ?? 0),
    cessSpecificPaise: zero
      ? 0n
      : divRound(input.qtyMicros * (input.cessPerUnitPaise ?? 0n), MICROS),
    taxability,
    why,
  };
}

function flagsOf(ctx: LineContext): PartyFlags {
  return ctx.lut ? { lut: true } : {};
}

export interface PricedLine {
  grossPaise: bigint;
  discountPaise: bigint;
  taxablePaise: bigint;
}

/** Step 1: price the line down to the value on which tax is charged. */
export function priceLine(input: LineInput, ctx: LineContext): Traced<PricedLine> {
  const trace: TraceStep[] = [];
  const eff = effective(input, ctx);
  const inclusive = input.pricing === 'inclusive' || input.discount.mode === 'price_includes_tax';

  const gross = divRound(input.qtyMicros * input.ratePaise, MICROS);
  trace.push(
    step(
      'line.gross',
      { qtyMicros: input.qtyMicros, ratePaise: input.ratePaise },
      gross,
      `quantity x rate = ${gross} paise${inclusive ? ' (rate includes tax)' : ''}`,
    ),
  );

  let discount = 0n;
  const d = input.discount;
  if (d.mode === 'percent') {
    discount = divRound(gross * BigInt(d.bp), BP);
  } else if (d.mode === 'per_unit') {
    discount = divRound(input.qtyMicros * d.perUnitPaise, MICROS);
  }
  discount = min(max(discount, 0n), gross);
  trace.push(
    step(
      'line.discount',
      { discount: d },
      discount,
      `discount (${d.mode}) = ${discount} paise, capped at the line value`,
    ),
  );

  const net = gross - discount;
  let taxable = net;
  if (inclusive) {
    const denominator = BP + eff.rateBp + eff.cessBp;
    taxable = max(0n, divRound((net - eff.cessSpecificPaise) * BP, denominator));
    trace.push(
      step(
        'line.inclusive_backcalc',
        { net, rateBp: eff.rateBp, cessBp: eff.cessBp, specificCess: eff.cessSpecificPaise },
        taxable,
        `taxable = (price - specific cess) x 10000 / (10000 + rate + cess) = ${taxable} paise`,
      ),
    );
  }
  trace.push(step('line.taxable', { net, inclusive }, taxable, `taxable value = ${taxable} paise`));
  return { result: { grossPaise: gross, discountPaise: discount, taxablePaise: taxable }, trace };
}

/** Step 2: charge tax on a taxable value (possibly reduced by a document-level discount). */
export function taxOn(
  input: LineInput,
  ctx: LineContext,
  priced: PricedLine,
  taxable: bigint,
): Traced<LineResult> {
  const trace: TraceStep[] = [];
  const eff = effective(input, ctx);
  if (eff.why)
    trace.push(step('line.no_tax', { taxability: eff.taxability, heads: eff.heads }, 0, eff.why));

  let cgst = 0n;
  let sgst = 0n;
  let utgst = 0n;
  let igst = 0n;
  if (eff.rateBp > 0n) {
    if (eff.heads === 'igst') {
      igst = divRound(taxable * eff.rateBp, BP);
    } else {
      const half = divRound(taxable * eff.rateBp, BP * 2n);
      cgst = half;
      if (eff.heads === 'cgst_utgst') utgst = half;
      else sgst = half;
    }
    trace.push(
      step(
        'line.gst',
        { taxable, rateBp: eff.rateBp, heads: eff.heads },
        { cgst, sgst, utgst, igst },
        eff.heads === 'igst'
          ? `IGST ${Number(eff.rateBp) / 100}% of ${taxable} = ${igst} paise`
          : `${eff.heads === 'cgst_utgst' ? 'CGST + UTGST' : 'CGST + SGST'}: ${Number(eff.rateBp) / 200}% each of ${taxable} = ${cgst} paise`,
      ),
    );
  }

  let cess = 0n;
  if (eff.cessBp > 0n || eff.cessSpecificPaise > 0n) {
    cess = divRound(taxable * eff.cessBp, BP) + eff.cessSpecificPaise;
    trace.push(
      step(
        'line.cess',
        { taxable, cessBp: eff.cessBp, specific: eff.cessSpecificPaise },
        cess,
        `cess = ad valorem ${Number(eff.cessBp) / 100}% + specific ${eff.cessSpecificPaise} paise = ${cess} paise`,
      ),
    );
  }

  const tax = cgst + sgst + utgst + igst + cess;
  const rcm = ctx.reverseCharge ? tax : 0n;
  const total = taxable + (ctx.reverseCharge ? 0n : tax);
  if (ctx.reverseCharge && tax > 0n) {
    trace.push(
      step(
        'line.rcm',
        { tax },
        rcm,
        'reverse charge: tax is computed but payable by the recipient, not invoiced',
      ),
    );
  }
  trace.push(
    step(
      'line.total',
      { taxable, tax, reverseCharge: !!ctx.reverseCharge },
      total,
      `line total = ${total} paise`,
    ),
  );

  return {
    result: {
      grossPaise: priced.grossPaise,
      discountPaise: priced.discountPaise,
      taxablePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: sgst,
      utgstPaise: utgst,
      igstPaise: igst,
      cessPaise: cess,
      taxPaise: tax,
      rcmTaxPaise: rcm,
      totalPaise: total,
      heads: eff.heads,
      appliedRateBp: Number(eff.rateBp),
      taxability: eff.taxability,
    },
    trace,
  };
}

/** Price and tax a single line. */
export function computeLine(input: LineInput, ctx: LineContext): Traced<LineResult> {
  const priced = priceLine(input, ctx);
  const taxed = taxOn(input, ctx, priced.result, priced.result.taxablePaise);
  return { result: taxed.result, trace: [...priced.trace, ...taxed.trace] };
}

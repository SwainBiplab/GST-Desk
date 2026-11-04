/**
 * Integer money arithmetic for document lines. BigInt internally because
 * qty_micros * rate_paise can exceed 2^53.
 *
 * This mirrors the rules the domain tax engine (prompt 05) must follow; DocumentRepo accepts any
 * `LineValidator`, so wiring in `@gst/domain` is a one-line change at construction time.
 */
import type { Row } from '../schema';

export type LineValidator = (doc: Row, lines: Row[]) => string[];

/** Round-half-away-from-zero integer division. */
function divRound(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return neg ? -q : q;
}

export interface ComputedLine {
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  utgst_paise: number;
  cess_paise: number;
  total_paise: number;
}

export function computeLine(l: Row): ComputedLine {
  const gross = divRound(BigInt(l['qty_micros']) * BigInt(l['rate_paise']), 1_000_000n);
  let discount = 0n;
  if (l['discount_mode'] === 'percent')
    discount = divRound(gross * BigInt(l['discount_value']), 10_000n);
  else if (l['discount_mode'] === 'amount') {
    const v = BigInt(l['discount_value']);
    discount = v > gross ? gross : v;
  }
  const taxable = gross - discount;
  const tax = (bp: unknown) => divRound(taxable * BigInt((bp as number) ?? 0), 10_000n);
  const cgst = tax(l['cgst_bp']);
  const sgst = tax(l['sgst_bp']);
  const igst = tax(l['igst_bp']);
  const utgst = tax(l['utgst_bp']);
  const cess = tax(l['cess_bp']);
  return {
    taxable_paise: Number(taxable),
    cgst_paise: Number(cgst),
    sgst_paise: Number(sgst),
    igst_paise: Number(igst),
    utgst_paise: Number(utgst),
    cess_paise: Number(cess),
    total_paise: Number(taxable + cgst + sgst + igst + utgst + cess),
  };
}

const LINE_FIELDS = [
  'taxable_paise',
  'cgst_paise',
  'sgst_paise',
  'igst_paise',
  'utgst_paise',
  'cess_paise',
  'total_paise',
] as const;

/** Document total = sum of line totals + TCS + round-off. TDS is deducted at payment, not here. */
export function computeTotals(doc: Row, lines: Row[]) {
  const sum = (k: string) => lines.reduce((a, l) => a + Number(l[k] ?? 0), 0);
  return {
    total_taxable_paise: sum('taxable_paise'),
    total_cgst_paise: sum('cgst_paise'),
    total_sgst_paise: sum('sgst_paise'),
    total_igst_paise: sum('igst_paise'),
    total_utgst_paise: sum('utgst_paise'),
    total_cess_paise: sum('cess_paise'),
    total_paise:
      sum('total_paise') + Number(doc['tcs_paise'] ?? 0) + Number(doc['round_off_paise'] ?? 0),
  };
}

/** Rejects lines and documents whose stored money fields differ from recomputation. */
export const arithmeticValidator: LineValidator = (doc, lines) => {
  const errors: string[] = [];
  for (const l of lines) {
    const expected = computeLine(l);
    for (const f of LINE_FIELDS) {
      if (Number(l[f]) !== expected[f]) {
        errors.push(`line ${l['line_no']}: ${f} is ${l[f]}, expected ${expected[f]}`);
      }
    }
  }
  const totals = computeTotals(
    doc,
    lines.map((l) => ({ ...l, ...computeLine(l) })),
  );
  for (const [k, v] of Object.entries(totals)) {
    if (Number(doc[k] ?? 0) !== v) errors.push(`document: ${k} is ${doc[k] ?? 0}, expected ${v}`);
  }
  return errors;
};

const HEADS = ['cgst', 'sgst', 'igst', 'utgst'] as const;

/**
 * Integrity check for documents built by the editor (`buildDocument` in `@gst/domain`). The engine
 * supports things a row cannot restate (tax-inclusive prices, per-unit discounts, an invoice-level
 * discount, reverse charge), so this does not re-derive a line from its rate and quantity. It checks
 * that the stored numbers agree with each other: every head of tax matches the taxable value and its
 * rate (to the rounding a basis-point column forces), line totals add up, document totals add up,
 * and the heads match the supply type. A tampered or half-written document fails.
 */
export const consistencyValidator: LineValidator = (doc, lines) => {
  const errors: string[] = [];
  const n = (v: unknown) => Number(v ?? 0);
  const reverse = !!doc['reverse_charge'];
  const supply = doc['supply_type'];
  const BP = 10_000n;

  for (const l of lines) {
    const no = l['line_no'];
    const taxable = BigInt(n(l['taxable_paise']));
    if (taxable < 0n) errors.push(`line ${no}: taxable_paise is negative`);
    // a basis-point column cannot hold half of 0.25%, so allow the rounding that costs
    const tolerance = taxable / 20_000n + 1n;
    let tax = 0n;
    for (const h of HEADS) {
      const paise = BigInt(n(l[`${h}_paise`]));
      const expected = divRound(taxable * BigInt(n(l[`${h}_bp`])), BP);
      const gap = paise > expected ? paise - expected : expected - paise;
      if (gap > tolerance)
        errors.push(`line ${no}: ${h}_paise is ${paise}, expected about ${expected}`);
      tax += paise;
    }
    const cess = BigInt(n(l['cess_paise']));
    const cessExpected = divRound(taxable * BigInt(n(l['cess_bp'])), BP);
    if (
      n(l['cess_bp']) > 0 &&
      (cess > cessExpected ? cess - cessExpected : cessExpected - cess) > tolerance
    )
      errors.push(`line ${no}: cess_paise is ${cess}, expected about ${cessExpected}`);
    tax += cess;
    const total = BigInt(n(l['total_paise']));
    const expectedTotal = reverse ? taxable : taxable + tax;
    if (total !== expectedTotal)
      errors.push(`line ${no}: total_paise is ${total}, expected ${expectedTotal}`);
    if (
      n(l['igst_paise']) > 0 &&
      (n(l['cgst_paise']) > 0 || n(l['sgst_paise']) > 0 || n(l['utgst_paise']) > 0)
    )
      errors.push(`line ${no}: IGST and CGST/SGST on the same line`);
    if (supply === 'intra' && n(l['igst_paise']) > 0)
      errors.push(`line ${no}: IGST on an intra-state supply`);
    if (
      supply === 'inter' &&
      (n(l['cgst_paise']) > 0 || n(l['sgst_paise']) > 0 || n(l['utgst_paise']) > 0)
    )
      errors.push(`line ${no}: CGST/SGST on an inter-state supply`);
  }

  const sum = (k: string) => lines.reduce((a, l) => a + n(l[k]), 0);
  const expected: Record<string, number> = {
    total_taxable_paise: sum('taxable_paise'),
    total_cgst_paise: sum('cgst_paise'),
    total_sgst_paise: sum('sgst_paise'),
    total_igst_paise: sum('igst_paise'),
    total_utgst_paise: sum('utgst_paise'),
    total_cess_paise: sum('cess_paise'),
    total_paise: sum('total_paise') + n(doc['tcs_paise']) + n(doc['round_off_paise']),
  };
  for (const [k, v] of Object.entries(expected)) {
    if (n(doc[k]) !== v) errors.push(`document: ${k} is ${n(doc[k])}, expected ${v}`);
  }
  return errors;
};

/**
 * The TDS, TCS and income-tax rules as typed data. The numbers live in `data/direct-tax.json`; nothing in
 * the code below states a rate, a threshold or a date. A change in the law is a change to that file.
 */
import raw from '../../data/direct-tax.json' with { type: 'json' };

export interface RulePeriod {
  from: string;
  to?: string;
  rateBp?: number;
  singleThresholdPaise?: number;
  aggregateThresholdPaise?: number;
  perTransactionThresholdPaise?: number;
}

export interface TdsRule {
  section: string;
  /** The section code the return-preparation utility asks for. */
  code: string;
  label: string;
  base: 'excl_gst' | 'incl_gst';
  /** 194C: the rate by who the payee is. */
  categories?: Record<'individual_huf' | 'other', number>;
  /** 194J: the rate by the kind of service. */
  kinds?: Record<'professional' | 'technical', number>;
  /** 194Q: tax only on what is above the threshold. */
  onExcessOnly?: boolean;
  /** 194Q: applies only to a buyer whose turnover in the previous year was above this. */
  buyerTurnoverFloorPaise?: number;
  periods: RulePeriod[];
}

export interface TcsRule {
  section: string;
  nature: string;
  code: string;
  label: string;
  base: 'excl_gst' | 'incl_gst';
  onExcessOnly?: boolean;
  periods: RulePeriod[];
}

export interface Slab {
  upTo: number | null;
  rateBp: number;
}
export interface SurchargeSlab {
  above: number;
  rateBp: number;
}
export interface RegimeNew {
  slabs: Slab[];
  rebate: { incomeLimitPaise: number; maxPaise: number };
  surchargeSlabs: SurchargeSlab[];
}
export interface RegimeOld {
  slabsByAge: Record<'below60' | 'senior' | 'super_senior', Slab[]>;
  rebate: { incomeLimitPaise: number; maxPaise: number };
  surchargeSlabs: SurchargeSlab[];
  limits: {
    section80C: number;
    section80CCD1B: number;
    section80D: number;
    section80DSenior: number;
    homeLoanInterest24b: number;
  };
}
export interface TaxYearRules {
  assessmentYear: string;
  note: string;
  new: RegimeNew;
  old: RegimeOld;
  cessBp: number;
}
export interface Instalment {
  due: string;
  cumulativeBp: number;
  relaxedBp?: number;
  months: number;
}

export interface DirectTaxData {
  version: string;
  verified: boolean;
  note: string;
  noPanRateBp: number;
  tds: TdsRule[];
  tcs: TcsRule[];
  due: {
    depositDay: number;
    marchDeposit: string;
    returnDates: Record<'Q1' | 'Q2' | 'Q3' | 'Q4', string>;
    lateDeductionInterestBpPerMonth: number;
    lateDepositInterestBpPerMonth: number;
  };
  incomeTax: {
    years: Record<string, TaxYearRules | { assessmentYear: string; note: string; sameAs: string }>;
    presumptive: {
      '44AD': {
        rateBp: number;
        digitalRateBp: number;
        turnoverLimitPaise: number;
        turnoverLimitDigitalPaise: number;
        cashReceiptShareLimitBp: number;
      };
      '44ADA': {
        rateBp: number;
        receiptsLimitPaise: number;
        receiptsLimitDigitalPaise: number;
        cashReceiptShareLimitBp: number;
      };
    };
    advanceTax: {
      minimumLiabilityPaise: number;
      instalments: Instalment[];
      section234BThresholdBp: number;
      interestBpPerMonth: number;
    };
  };
}

export const DIRECT_TAX = raw as unknown as DirectTaxData;

/** The period of a rule that is in force on `date` (the latest one that has started and not ended). */
export function periodAt<T extends { from: string; to?: string }>(
  periods: readonly T[],
  date: string,
): T | null {
  let best: T | null = null;
  for (const p of periods) {
    if (p.from <= date && (p.to === undefined || date <= p.to) && (!best || p.from > best.from))
      best = p;
  }
  return best;
}

export function tdsRule(section: string, data: DirectTaxData = DIRECT_TAX): TdsRule | null {
  return data.tds.find((r) => r.section === section) ?? null;
}

export function tcsRule(nature: string, data: DirectTaxData = DIRECT_TAX): TcsRule | null {
  return data.tcs.find((r) => r.nature === nature) ?? null;
}

/** The rules of a tax year, following a `sameAs` pointer. Null when the year is unknown. */
export function taxYearRules(fy: string, data: DirectTaxData = DIRECT_TAX): TaxYearRules | null {
  const y = data.incomeTax.years[fy];
  if (!y) return null;
  if ('sameAs' in y) {
    const base = data.incomeTax.years[y.sameAs];
    if (!base || 'sameAs' in base) return null;
    return { ...base, assessmentYear: y.assessmentYear, note: y.note };
  }
  return y;
}

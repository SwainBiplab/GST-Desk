/**
 * Document-level totals: invoice discount allocation, TCS, TDS and round-off.
 *
 * Rules: CGST Act s.15(3) (invoice-level discount reduces value pro rata), Income-tax Act s.206C(1H)
 * (TCS on sale consideration above Rs 50 lakh; omitted for receipts on or after 1 Oct 2024) and s.194Q
 * (TDS by the buyer on purchases above Rs 50 lakh; the seller then does not collect TCS), and the GST
 * invoice round-off convention (nearest rupee).
 */
import { BP, allocate, divRound, max, min, roundToRupee, sum } from '../money';
import { step, type TraceStep, type Traced } from '../trace';

import {
  computeLine,
  priceLine,
  taxOn,
  type LineContext,
  type LineInput,
  type LineResult,
  type PricedLine,
} from './line';

/** Rs 50 lakh in paise. */
export const FIFTY_LAKH = 500_000_000n;
/** 206C(1H) stopped applying to consideration received on or after this date. */
export const TCS_206C1H_SUNSET = '2024-10-01';

export type InvoiceDiscount = { mode: 'percent'; bp: number } | { mode: 'amount'; paise: bigint };

export interface TcsOptions {
  /** Rate in basis points (10 = 0.1%, 100 = 1% when PAN is missing). */
  rateBp: number;
  /** Sale value already invoiced to this party in the FY, including GST. */
  cumulativeBeforePaise: bigint;
  thresholdPaise?: bigint;
  /** ISO date; TCS is not collected on or after this date. Defaults to 2024-10-01. */
  sunsetDate?: string;
}

export interface TdsOptions {
  /** Section 194Q rate in basis points (10 = 0.1%). */
  rateBp: number;
  /** Taxable value already purchased from this seller in the FY. */
  cumulativeBeforePaise: bigint;
  thresholdPaise?: bigint;
  /** Set when the buyer will deduct 194Q on this document; the seller then collects no TCS. */
  applicable?: boolean;
}

export interface DocumentOptions extends LineContext {
  invoiceDiscount?: InvoiceDiscount;
  roundOff?: 'none' | 'nearest_rupee';
  /** ISO document date (YYYY-MM-DD); needed for TCS sunset. Never read from the clock. */
  date?: string;
  tcs?: TcsOptions;
  tds?: TdsOptions;
}

export interface DocumentTotals {
  discountPaise: bigint;
  invoiceDiscountPaise: bigint;
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  utgstPaise: bigint;
  igstPaise: bigint;
  cessPaise: bigint;
  taxPaise: bigint;
  rcmTaxPaise: bigint;
  /** Sum of line totals before TCS and round-off. */
  linesTotalPaise: bigint;
  tcsPaise: bigint;
  roundOffPaise: bigint;
  /** Invoice total = lines total + TCS + round-off. TDS is not part of it. */
  totalPaise: bigint;
  /** TDS the buyer will deduct at payment (194Q). */
  tdsPaise: bigint;
  netReceivablePaise: bigint;
}

export interface DocumentResult {
  lines: LineResult[];
  totals: DocumentTotals;
}

function tcsAmount(
  tcs: TcsOptions,
  tds: TdsOptions | undefined,
  date: string | undefined,
  linesTotal: bigint,
): { amount: bigint; trace: TraceStep } {
  const threshold = tcs.thresholdPaise ?? FIFTY_LAKH;
  const sunset = tcs.sunsetDate ?? TCS_206C1H_SUNSET;
  if (tds?.applicable) {
    return {
      amount: 0n,
      trace: step(
        'tcs.206C1H',
        { tds: 'applicable' },
        0,
        'buyer deducts TDS u/s 194Q, so no TCS u/s 206C(1H) is collected',
      ),
    };
  }
  if (date !== undefined && date >= sunset) {
    return {
      amount: 0n,
      trace: step(
        'tcs.206C1H',
        { date, sunset },
        0,
        `206C(1H) does not apply on or after ${sunset}`,
      ),
    };
  }
  const over = max(0n, min(linesTotal, tcs.cumulativeBeforePaise + linesTotal - threshold));
  const amount = divRound(over * BigInt(tcs.rateBp), BP);
  return {
    amount,
    trace: step(
      'tcs.206C1H',
      { cumulativeBefore: tcs.cumulativeBeforePaise, linesTotal, threshold, rateBp: tcs.rateBp },
      amount,
      over === 0n
        ? 'cumulative sales stay within the Rs 50 lakh threshold: no TCS'
        : `TCS on ${over} paise above the threshold at ${tcs.rateBp / 100}% = ${amount} paise`,
    ),
  };
}

export function computeDocument(
  lines: readonly LineInput[],
  options: DocumentOptions,
): Traced<DocumentResult> {
  const trace: TraceStep[] = [];
  const ctx: LineContext = {
    supply: options.supply,
    supplierState: options.supplierState,
    ...(options.lut !== undefined ? { lut: options.lut } : {}),
    ...(options.reverseCharge !== undefined ? { reverseCharge: options.reverseCharge } : {}),
    ...(options.composition !== undefined ? { composition: options.composition } : {}),
  };

  // 1. price every line
  const priced: PricedLine[] = [];
  lines.forEach((l, i) => {
    const p = priceLine(l, ctx);
    priced.push(p.result);
    trace.push(...p.trace.map((t) => ({ ...t, rule: `lines[${i}].${t.rule}` })));
  });

  // 2. allocate the invoice-level discount pro rata to taxable value
  const lineTaxable = priced.map((p) => p.taxablePaise);
  const lineTaxableSum = sum(lineTaxable);
  let invoiceDiscount = 0n;
  const dis = options.invoiceDiscount;
  if (dis) {
    invoiceDiscount =
      dis.mode === 'percent' ? divRound(lineTaxableSum * BigInt(dis.bp), BP) : dis.paise;
    invoiceDiscount = min(max(invoiceDiscount, 0n), lineTaxableSum);
  }
  const shares =
    invoiceDiscount > 0n ? allocate(invoiceDiscount, lineTaxable) : lineTaxable.map(() => 0n);
  if (dis) {
    trace.push(
      step(
        'doc.invoice_discount',
        { discount: dis, taxableBefore: lineTaxableSum },
        { total: invoiceDiscount, shares },
        `invoice discount ${invoiceDiscount} paise allocated pro rata to taxable value (largest remainder)`,
      ),
    );
  }

  // 3. tax each line on its reduced taxable value
  const results: LineResult[] = [];
  lines.forEach((l, i) => {
    const t = taxOn(l, ctx, priced[i]!, priced[i]!.taxablePaise - shares[i]!);
    results.push(t.result);
    trace.push(...t.trace.map((x) => ({ ...x, rule: `lines[${i}].${x.rule}` })));
  });

  const s = (pick: (r: LineResult) => bigint) => sum(results.map(pick));
  const taxable = s((r) => r.taxablePaise);
  const linesTotal = s((r) => r.totalPaise);
  trace.push(
    step(
      'doc.lines_total',
      { taxable, tax: s((r) => r.taxPaise) },
      linesTotal,
      `sum of line totals = ${linesTotal} paise`,
    ),
  );

  // 4. TCS, then round-off
  let tcs = 0n;
  if (options.tcs) {
    const r = tcsAmount(options.tcs, options.tds, options.date, linesTotal);
    tcs = r.amount;
    trace.push(r.trace);
  }
  const before = linesTotal + tcs;
  const roundOff = options.roundOff === 'nearest_rupee' ? roundToRupee(before) - before : 0n;
  if (options.roundOff === 'nearest_rupee') {
    trace.push(
      step('doc.round_off', { before }, roundOff, `round to nearest rupee: ${roundOff} paise`),
    );
  }
  const total = before + roundOff;

  // 5. TDS 194Q (informational: deducted when paying)
  let tds = 0n;
  if (options.tds) {
    const threshold = options.tds.thresholdPaise ?? FIFTY_LAKH;
    const over = max(0n, min(taxable, options.tds.cumulativeBeforePaise + taxable - threshold));
    tds = divRound(over * BigInt(options.tds.rateBp), BP);
    trace.push(
      step(
        'tds.194Q',
        {
          cumulativeBefore: options.tds.cumulativeBeforePaise,
          taxable,
          threshold,
          rateBp: options.tds.rateBp,
        },
        tds,
        over === 0n
          ? 'purchases stay within the Rs 50 lakh threshold: no TDS'
          : `TDS on ${over} paise above the threshold = ${tds} paise`,
      ),
    );
  }
  trace.push(
    step('doc.total', { linesTotal, tcs, roundOff }, total, `invoice total = ${total} paise`),
  );

  const totals: DocumentTotals = {
    discountPaise: s((r) => r.discountPaise),
    invoiceDiscountPaise: invoiceDiscount,
    taxablePaise: taxable,
    cgstPaise: s((r) => r.cgstPaise),
    sgstPaise: s((r) => r.sgstPaise),
    utgstPaise: s((r) => r.utgstPaise),
    igstPaise: s((r) => r.igstPaise),
    cessPaise: s((r) => r.cessPaise),
    taxPaise: s((r) => r.taxPaise),
    rcmTaxPaise: s((r) => r.rcmTaxPaise),
    linesTotalPaise: linesTotal,
    tcsPaise: tcs,
    roundOffPaise: roundOff,
    totalPaise: total,
    tdsPaise: tds,
    netReceivablePaise: total - tds,
  };
  return { result: { lines: results, totals }, trace };
}

export { computeLine };

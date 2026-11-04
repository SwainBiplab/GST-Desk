import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  computeDocument,
  postDocument,
  type DocumentOptions,
  type LineInput,
  type PostableDocument,
} from '../src';

const RATES = [0, 50, 250, 300, 500, 1200, 1800, 2800];

const lineArb: fc.Arbitrary<LineInput> = fc.record({
  qtyMicros: fc.integer({ min: 1, max: 100_000_000 }).map(BigInt),
  ratePaise: fc.integer({ min: 0, max: 5_000_000 }).map(BigInt),
  discount: fc.oneof(
    fc.constant({ mode: 'none' as const }),
    fc.integer({ min: 0, max: 10_000 }).map((bp) => ({ mode: 'percent' as const, bp })),
    fc
      .integer({ min: 0, max: 100_000 })
      .map((v) => ({ mode: 'per_unit' as const, perUnitPaise: BigInt(v) })),
  ),
  pricing: fc.constantFrom('exclusive' as const, 'inclusive' as const),
  gstRateBp: fc.constantFrom(...RATES),
  cessBp: fc.constantFrom(0, 100, 1200),
  cessPerUnitPaise: fc.integer({ min: 0, max: 2_000 }).map(BigInt),
});

const linesArb = fc.array(lineArb, { minLength: 1, maxLength: 8 });
const discountArb = fc.option(
  fc.oneof(
    fc.integer({ min: 0, max: 5_000 }).map((bp) => ({ mode: 'percent' as const, bp })),
    fc
      .integer({ min: 0, max: 500_000 })
      .map((v) => ({ mode: 'amount' as const, paise: BigInt(v) })),
  ),
  { nil: undefined },
);

describe('properties', () => {
  it('sum of line totals equals the document total before round-off and TCS', () => {
    fc.assert(
      fc.property(linesArb, discountArb, (lines, invoiceDiscount) => {
        const { result } = computeDocument(lines, {
          supply: 'intra',
          supplierState: '27',
          ...(invoiceDiscount ? { invoiceDiscount } : {}),
          roundOff: 'nearest_rupee',
        });
        const sum = result.lines.reduce((a, l) => a + l.totalPaise, 0n);
        expect(result.totals.linesTotalPaise).toBe(sum);
        expect(result.totals.totalPaise).toBe(
          sum + result.totals.tcsPaise + result.totals.roundOffPaise,
        );
        expect(result.totals.roundOffPaise >= -50n && result.totals.roundOffPaise <= 50n).toBe(
          true,
        );
        expect(result.totals.totalPaise % 100n).toBe(0n);
      }),
      { numRuns: 300 },
    );
  });

  it('intra-state: CGST equals SGST and IGST is zero', () => {
    fc.assert(
      fc.property(linesArb, discountArb, (lines, invoiceDiscount) => {
        const { result } = computeDocument(lines, {
          supply: 'intra',
          supplierState: '27',
          ...(invoiceDiscount ? { invoiceDiscount } : {}),
        });
        for (const l of result.lines) {
          expect(l.cgstPaise).toBe(l.sgstPaise);
          expect(l.igstPaise).toBe(0n);
          expect(l.utgstPaise).toBe(0n);
        }
        expect(result.totals.cgstPaise).toBe(result.totals.sgstPaise);
      }),
      { numRuns: 300 },
    );
  });

  it('UT without legislature: CGST equals UTGST and SGST is zero', () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const { result } = computeDocument(lines, { supply: 'intra', supplierState: '04' });
        expect(result.totals.cgstPaise).toBe(result.totals.utgstPaise);
        expect(result.totals.sgstPaise).toBe(0n);
      }),
      { numRuns: 100 },
    );
  });

  it('inter-state: IGST only, CGST/SGST/UTGST are zero', () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const { result } = computeDocument(lines, { supply: 'inter', supplierState: '27' });
        expect(result.totals.cgstPaise).toBe(0n);
        expect(result.totals.sgstPaise).toBe(0n);
        expect(result.totals.utgstPaise).toBe(0n);
        for (const l of result.lines) expect(l.igstPaise >= 0n).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('invoice discount is allocated exactly and never makes a line negative', () => {
    fc.assert(
      fc.property(linesArb, fc.integer({ min: 0, max: 10_000_000 }), (lines, d) => {
        const base = computeDocument(lines, { supply: 'intra', supplierState: '27' }).result.totals;
        const { result } = computeDocument(lines, {
          supply: 'intra',
          supplierState: '27',
          invoiceDiscount: { mode: 'amount', paise: BigInt(d) },
        });
        const expected = BigInt(d) > base.taxablePaise ? base.taxablePaise : BigInt(d);
        expect(result.totals.invoiceDiscountPaise).toBe(expected);
        expect(result.totals.taxablePaise).toBe(base.taxablePaise - expected);
        for (const l of result.lines) expect(l.taxablePaise >= 0n).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('ledger postings balance for every posting document type', () => {
    const types = [
      'tax_invoice',
      'bill_of_supply',
      'debit_note',
      'credit_note',
      'purchase_bill',
      'purchase_return',
      'expense',
    ] as const;
    fc.assert(
      fc.property(
        linesArb,
        fc.constantFrom(...types),
        fc.constantFrom('intra', 'inter', 'sez_with_tax', 'export') as fc.Arbitrary<
          DocumentOptions['supply']
        >,
        fc.boolean(),
        fc.boolean(),
        (lines, type, supply, reverseCharge, withTcs) => {
          const { result } = computeDocument(lines, {
            supply,
            supplierState: '27',
            reverseCharge,
            roundOff: 'nearest_rupee',
            date: '2024-05-01',
            ...(withTcs ? { tcs: { rateBp: 10, cumulativeBeforePaise: 499_999_000n } } : {}),
          });
          const t = result.totals;
          const doc: PostableDocument = {
            type,
            status: 'issued',
            taxablePaise: t.taxablePaise,
            cgstPaise: t.cgstPaise,
            sgstPaise: t.sgstPaise,
            utgstPaise: t.utgstPaise,
            igstPaise: t.igstPaise,
            cessPaise: t.cessPaise,
            tcsPaise: t.tcsPaise,
            roundOffPaise: t.roundOffPaise,
            totalPaise: t.totalPaise,
            reverseCharge,
          };
          const posted = postDocument(doc);
          const dr = posted.reduce((a, l) => a + l.debitPaise, 0n);
          const cr = posted.reduce((a, l) => a + l.creditPaise, 0n);
          expect(dr).toBe(cr);
        },
      ),
      { numRuns: 300 },
    );
  });
});

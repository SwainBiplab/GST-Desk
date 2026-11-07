import { describe, expect, it } from 'vitest';

import {
  LATE_FEE_CAPS,
  iffJson,
  iffMonths,
  lateFee,
  monthPeriod,
  nilGstr1Json,
  quarterPeriod,
} from '../src';

const CR = 10_000_000_00n;

describe('late fee estimate', () => {
  it('is nothing on or before the due date', () => {
    expect(lateFee({ due: '2026-11-11', on: '2026-11-11', nil: false }).feePaise).toBe(0n);
    expect(lateFee({ due: '2026-11-11', on: '2026-11-01', nil: false }).days).toBe(0);
  });
  it('is Rs 50 a day, Rs 20 a day for a nil return', () => {
    expect(lateFee({ due: '2026-11-11', on: '2026-11-21', nil: false }).feePaise).toBe(50_000n);
    expect(lateFee({ due: '2026-11-11', on: '2026-11-21', nil: true }).feePaise).toBe(20_000n);
  });
  it('stops at the cap for the turnover band, and says so', () => {
    const base = { due: '2026-01-11', on: '2026-12-31', nil: false } as const;
    expect(lateFee({ ...base, turnoverPaise: CR }).feePaise).toBe(LATE_FEE_CAPS.upTo1_5Cr);
    expect(lateFee({ ...base, turnoverPaise: 3n * CR }).feePaise).toBe(LATE_FEE_CAPS.upTo5Cr);
    expect(lateFee({ ...base, turnoverPaise: 9n * CR }).feePaise).toBe(LATE_FEE_CAPS.above5Cr);
    expect(lateFee({ ...base, turnoverPaise: null }).feePaise).toBe(LATE_FEE_CAPS.above5Cr);
    expect(lateFee({ ...base, nil: true, turnoverPaise: CR })).toMatchObject({
      feePaise: LATE_FEE_CAPS.nil,
      capped: true,
    });
  });
  it('carries the rule version so a screen can call it an estimate', () => {
    expect(lateFee({ due: '2026-11-11', on: '2026-11-12', nil: false }).version).toContain(
      'unreviewed',
    );
  });
});

describe('nil return and QRMP', () => {
  const gstin = '27AABCD1234E1Z8';
  it('a nil GSTR-1 file names the period and says nil', () => {
    expect(nilGstr1Json(monthPeriod(gstin, 2026, 10))).toEqual({
      gstin,
      fp: '102026',
      nil_return: true,
    });
  });
  it('IFF is for the first two months of a quarter, due the 13th of the month after', () => {
    expect(iffMonths(quarterPeriod(gstin, 2026, 12))).toEqual([
      { fp: '102026', from: '2026-10-01', to: '2026-10-31', due: '2026-11-13' },
      { fp: '112026', from: '2026-11-01', to: '2026-11-30', due: '2026-12-13' },
    ]);
    expect(iffMonths(quarterPeriod(gstin, 2026, 3))[1]).toMatchObject({
      fp: '022026',
      to: '2026-02-28',
      due: '2026-03-13',
    });
    expect(iffMonths(monthPeriod(gstin, 2026, 10))).toEqual([]);
  });
  it('the IFF file keeps only B2B and credit/debit notes', () => {
    const f = iffJson({ gstin, fp: '102026', b2b: [1], b2cs: [2], cdnr: [3], hsn: {} });
    expect(Object.keys(f).sort()).toEqual(['b2b', 'cdnr', 'fp', 'gstin']);
  });
});

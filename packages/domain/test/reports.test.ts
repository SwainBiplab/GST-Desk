import { describe, expect, it } from 'vitest';

import {
  ageInto,
  ageingBucket,
  daysBetween,
  addDays,
  emptyAgeing,
  filingCalendar,
  netTurnoverPaise,
  presetOf,
  purchaseSign,
  resolvePeriod,
  sameDaysLastMonth,
  turnoverSign,
  type DocumentType,
} from '../src';

describe('turnover inclusion (FR-072)', () => {
  const signs: [DocumentType, number][] = [
    ['tax_invoice', 1],
    ['bill_of_supply', 1],
    ['debit_note', 1],
    ['credit_note', -1],
    ['proforma', 0],
    ['quotation', 0],
    ['delivery_challan', 0],
    ['receipt_voucher', 0],
    ['purchase_bill', 0],
    ['expense', 0],
  ];
  it.each(signs)('%s counts as %i when issued', (type, sign) => {
    expect(turnoverSign(type, 'issued')).toBe(sign);
  });
  it('never counts a draft or a cancelled document', () => {
    for (const [type] of signs) {
      expect(turnoverSign(type, 'draft')).toBe(0);
      expect(turnoverSign(type, 'cancelled')).toBe(0);
    }
  });
  it('nets credit notes off and ignores proformas and cancelled invoices', () => {
    expect(
      netTurnoverPaise([
        { type: 'tax_invoice', status: 'issued', taxablePaise: 100_000n },
        { type: 'bill_of_supply', status: 'issued', taxablePaise: 50_000n },
        { type: 'credit_note', status: 'issued', taxablePaise: 30_000n },
        { type: 'debit_note', status: 'issued', taxablePaise: 5_000n },
        { type: 'proforma', status: 'issued', taxablePaise: 999_999n },
        { type: 'tax_invoice', status: 'cancelled', taxablePaise: 777_777n },
        { type: 'tax_invoice', status: 'draft', taxablePaise: 555_555n },
      ]),
    ).toBe(125_000n);
  });
  it('purchases: bills add, returns subtract, expenses are separate', () => {
    expect(purchaseSign('purchase_bill', 'issued')).toBe(1);
    expect(purchaseSign('purchase_return', 'issued')).toBe(-1);
    expect(purchaseSign('expense', 'issued')).toBe(0);
    expect(purchaseSign('purchase_bill', 'cancelled')).toBe(0);
  });
});

describe('period presets', () => {
  // Wednesday 12 Feb 2025, in FY 24-25, Q4 (Jan to Mar)
  const today = '2025-02-12';
  it.each([
    ['today', '2025-02-12', '2025-02-12'],
    ['yesterday', '2025-02-11', '2025-02-11'],
    ['this_month', '2025-02-01', '2025-02-28'],
    ['last_month', '2025-01-01', '2025-01-31'],
    ['this_quarter', '2025-01-01', '2025-03-31'],
    ['last_quarter', '2024-10-01', '2024-12-31'],
    ['this_fy', '2024-04-01', '2025-03-31'],
    ['last_fy', '2023-04-01', '2024-03-31'],
  ] as const)('%s', (preset, from, to) => {
    expect(resolvePeriod(preset, today)).toEqual({ from, to });
  });

  it('knows leap Februaries and year ends', () => {
    expect(resolvePeriod('this_month', '2024-02-10').to).toBe('2024-02-29');
    expect(resolvePeriod('last_month', '2025-01-05')).toEqual({
      from: '2024-12-01',
      to: '2024-12-31',
    });
  });

  it('puts April, May and June in the first quarter and counts back across the year', () => {
    expect(resolvePeriod('this_quarter', '2024-05-20')).toEqual({
      from: '2024-04-01',
      to: '2024-06-30',
    });
    expect(resolvePeriod('last_quarter', '2024-05-20')).toEqual({
      from: '2024-01-01',
      to: '2024-03-31',
    });
    expect(resolvePeriod('this_quarter', '2024-12-31')).toEqual({
      from: '2024-10-01',
      to: '2024-12-31',
    });
  });

  it('switches financial year on 1 April, not 31 March', () => {
    expect(resolvePeriod('this_fy', '2025-03-31').from).toBe('2024-04-01');
    expect(resolvePeriod('this_fy', '2025-04-01').from).toBe('2025-04-01');
  });

  it('reads a calendar-year business (starts in January)', () => {
    expect(resolvePeriod('this_fy', '2025-06-10', 1)).toEqual({
      from: '2025-01-01',
      to: '2025-12-31',
    });
    expect(resolvePeriod('this_quarter', '2025-06-10', 1)).toEqual({
      from: '2025-04-01',
      to: '2025-06-30',
    });
  });

  it('finds the preset a pair of dates equals', () => {
    expect(presetOf({ from: '2025-02-01', to: '2025-02-28' }, today)).toBe('this_month');
    expect(presetOf({ from: '2025-02-02', to: '2025-02-28' }, today)).toBe('custom');
  });

  it('compares with the same days a month earlier, clipped to the month', () => {
    expect(sameDaysLastMonth({ from: '2025-03-01', to: '2025-03-31' })).toEqual({
      from: '2025-02-01',
      to: '2025-02-28',
    });
    expect(sameDaysLastMonth({ from: '2025-01-01', to: '2025-01-15' })).toEqual({
      from: '2024-12-01',
      to: '2024-12-15',
    });
  });

  it('adds and counts days across month ends', () => {
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(daysBetween('2024-12-25', '2025-01-05')).toBe(11);
  });
});

describe('ageing', () => {
  it.each([
    [-5, 'notDue'],
    [0, 'notDue'],
    [1, 'd1_30'],
    [30, 'd1_30'],
    [31, 'd31_60'],
    [60, 'd31_60'],
    [61, 'd61_90'],
    [90, 'd61_90'],
    [91, 'd90plus'],
    [400, 'd90plus'],
  ] as const)('%i days past due is %s', (days, bucket) => {
    expect(ageingBucket(days)).toBe(bucket);
  });

  it('ages from the due date, or from the document date when there is none', () => {
    const row = emptyAgeing();
    ageInto(row, 100n, '2025-02-20', '2025-01-01', '2025-02-12'); // not yet due
    ageInto(row, 200n, '2025-02-02', '2025-01-01', '2025-02-12'); // 10 days
    ageInto(row, 400n, null, '2024-12-01', '2025-02-12'); // 73 days from the date
    ageInto(row, 800n, '2024-10-01', '2024-09-01', '2025-02-12'); // 134 days
    expect(row).toEqual({ notDue: 100n, d1_30: 200n, d31_60: 0n, d61_90: 400n, d90plus: 800n });
  });
});

describe('filing calendar', () => {
  it('lists the usual dates for last month and this month, soonest first', () => {
    const c = filingCalendar('2025-02-05');
    expect(c.map((f) => `${f.form} ${f.period} ${f.due}`)).toEqual([
      'gstr1 2025-01 2025-02-11',
      'gstr3b 2025-01 2025-02-20',
      'gstr1 2025-02 2025-03-11',
      'gstr3b 2025-02 2025-03-20',
    ]);
    expect(c[0]!.inDays).toBe(6);
  });
  it('keeps a return that was due a few days ago, then drops it', () => {
    expect(filingCalendar('2025-02-14')[0]).toMatchObject({ form: 'gstr1', inDays: -3 });
    expect(filingCalendar('2025-02-25').some((f) => f.due === '2025-02-11')).toBe(false);
  });
  it('rolls over the year end', () => {
    const c = filingCalendar('2025-01-03');
    expect(c[0]).toMatchObject({ form: 'gstr1', period: '2024-12', due: '2025-01-11' });
  });
});

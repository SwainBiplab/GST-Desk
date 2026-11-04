import { describe, expect, it } from 'vitest';

import {
  NumberingError,
  classifyEdit,
  formatDocumentNumber,
  isLockedDate,
  isProvisional,
  lastSerial,
  previewSeries,
  provisionalNumber,
  reverseEntries,
  cancelBlocker,
  seriesClash,
  serialDigitsAvailable,
  takeNext,
  validateSeries,
  type SeriesSettings,
} from '../src';

const base: SeriesSettings = {
  name: 'Retail',
  prefix: 'INV/{FY}/',
  suffix: '',
  padding: 4,
  reset: 'fy',
  start: 1,
};

describe('series settings', () => {
  it('accepts a normal series and previews the next number', () => {
    expect(validateSeries(base)).toEqual([]);
    expect(previewSeries(base, 7, '2025-08-01')).toBe('INV/25-26/0007');
  });

  it('rejects characters the GST rule does not allow, at settings time', () => {
    const p = validateSeries({ ...base, prefix: 'INV#', suffix: ' x' });
    expect(p.map((x) => x.field).sort()).toEqual(['prefix', 'suffix']);
    expect(validateSeries({ ...base, prefix: '{BAD}' })[0]?.field).toBe('prefix');
  });

  it('knows how wide each token renders when it checks the 16 character limit', () => {
    // INV/{FY}/ renders 4 + 5 + 1 = 10 wide, leaving 6 digits
    expect(serialDigitsAvailable(base)).toBe(6);
    expect(validateSeries({ ...base, padding: 7 })[0]?.field).toBe('format');
    expect(validateSeries({ ...base, padding: 6 })).toEqual([]);
    expect(lastSerial(base)).toBe(999_999);
  });

  it('refuses a prefix that leaves no room for a number', () => {
    expect(validateSeries({ ...base, prefix: 'ABCDEFGHIJKLMNOP' })[0]?.field).toBe('format');
  });

  it('padding overflow: a serial wider than the padding still counts, and past 16 characters it throws', () => {
    const spec = { prefix: 'A', suffix: '', padding: 2, reset: 'never' as const };
    expect(formatDocumentNumber(spec, 123, '2025-08-01')).toBe('A123');
    expect(() =>
      formatDocumentNumber({ ...spec, prefix: 'ABCDEFGHIJKLMN' }, 123, '2025-08-01'),
    ).toThrow(NumberingError);
  });

  it('a rename changes future numbers only: numbers already formatted do not move', () => {
    const issued = formatDocumentNumber(base, 5, '2025-08-01');
    const renamed = { ...base, prefix: 'TI/{FY}/' };
    expect(formatDocumentNumber(renamed, 6, '2025-08-01')).toBe('TI/25-26/0006');
    expect(issued).toBe('INV/25-26/0005'); // a string already issued is data, not derived
  });

  it('two series of one type need different affixes', () => {
    expect(seriesClash(base, { ...base })).toBe(true);
    expect(seriesClash(base, { ...base, prefix: 'WS/{FY}/' })).toBe(false);
  });

  it('honours the start number', () => {
    expect(previewSeries({ ...base, start: 100 }, 1, '2025-08-01')).toBe('INV/25-26/0100');
  });
});

describe('financial-year rollover', () => {
  it('restarts at 1 on 1 April when the series resets by year, and not on 31 March', () => {
    let state = { next: 1, fy: null as string | null };
    const take = (date: string) => {
      const r = takeNext(base, state, date);
      state = r.state;
      return r.number;
    };
    expect(take('2026-03-30')).toBe('INV/25-26/0001');
    expect(take('2026-03-31')).toBe('INV/25-26/0002');
    expect(take('2026-04-01')).toBe('INV/26-27/0001');
    expect(take('2026-04-02')).toBe('INV/26-27/0002');
  });

  it('keeps counting when the series never resets', () => {
    const spec = { ...base, prefix: 'S-', reset: 'never' as const };
    let state = { next: 1, fy: null as string | null };
    const nums = ['2026-03-31', '2026-04-01'].map((d) => {
      const r = takeNext(spec, state, d);
      state = r.state;
      return r.number;
    });
    expect(nums).toEqual(['S-0001', 'S-0002']);
  });
});

describe('provisional numbers', () => {
  it('are recognisable and fit the number rules', () => {
    expect(provisionalNumber(7)).toBe('PROV-0007');
    expect(isProvisional('PROV-0007')).toBe(true);
    expect(isProvisional('INV/25-26/0007')).toBe(false);
  });
});

describe('period lock and editing', () => {
  it('locks the day itself and earlier, not later days', () => {
    const lock = { until: '2026-03-31' };
    expect(isLockedDate(lock, '2026-03-31')).toBe(true);
    expect(isLockedDate(lock, '2026-04-01')).toBe(false);
    expect(isLockedDate(null, '2020-01-01')).toBe(false);
  });

  it('notes, terms, reference and due date are non-financial; anything else is financial', () => {
    expect(classifyEdit([])).toBe('none');
    expect(classifyEdit(['notes', 'reference'])).toBe('non_financial');
    expect(classifyEdit(['notes', 'total_paise'])).toBe('financial');
    expect(classifyEdit(['party_id'])).toBe('financial');
  });
});

describe('cancellation', () => {
  it('reverses postings by swapping debit and credit', () => {
    const out = reverseEntries([
      { account: 'receivables', debitPaise: 118n, creditPaise: 0n },
      { account: 'sales', debitPaise: 0n, creditPaise: 100n },
    ]);
    expect(out[0]).toMatchObject({ debitPaise: 0n, creditPaise: 118n });
    expect(out[1]).toMatchObject({ debitPaise: 100n, creditPaise: 0n });
  });

  it('says why a document cannot be cancelled', () => {
    expect(cancelBlocker({ status: 'issued', hasIrn: false })).toBeNull();
    expect(cancelBlocker({ status: 'draft', hasIrn: false })).toMatch(/discard/);
    expect(cancelBlocker({ status: 'cancelled', hasIrn: false })).toMatch(/already/);
    expect(cancelBlocker({ status: 'issued', hasIrn: true })).toMatch(/e-invoice/);
  });
});

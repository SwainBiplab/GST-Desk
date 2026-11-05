import { describe, expect, it } from 'vitest';

import { formatDateIN, formatRupees, fyDisplayLabel, parseDateIN } from './format';

describe('dates', () => {
  it('writes dd-MM-yyyy', () => {
    expect(formatDateIN('2026-05-01')).toBe('01-05-2026');
    expect(formatDateIN('2026-12-31T10:00:00Z')).toBe('31-12-2026');
    expect(formatDateIN(new Date(2026, 0, 9))).toBe('09-01-2026');
    expect(formatDateIN('not a date')).toBe('not a date');
  });
  it('reads dd-MM-yyyy back and refuses dates that do not exist', () => {
    expect(parseDateIN('01-05-2026')).toBe('2026-05-01');
    expect(parseDateIN('1/5/2026')).toBe('2026-05-01');
    expect(parseDateIN('31-02-2026')).toBeNull();
    expect(parseDateIN('2026-05-01')).toBeNull();
  });
});

describe('financial years', () => {
  it('writes 2025-26', () => {
    expect(fyDisplayLabel('25-26')).toBe('2025-26');
    expect(fyDisplayLabel(2025)).toBe('2025-26');
    expect(fyDisplayLabel(2099)).toBe('2099-00');
    expect(fyDisplayLabel('2025-26')).toBe('2025-26');
  });
});

describe('rupees', () => {
  it('groups in lakhs and crores, with the sign touching the number', () => {
    expect(formatRupees(12345600)).toBe('₹1,23,456.00');
    expect(formatRupees(100)).toBe('₹1.00');
    expect(formatRupees(5)).toBe('₹0.05');
    expect(formatRupees(123456789012n)).toBe('₹1,23,45,67,890.12');
    expect(formatRupees(-250000)).toBe('-₹2,500.00');
  });
  it('has a plain-text form with a space and a bare form', () => {
    expect(formatRupees(12345600, 'rs')).toBe('Rs. 1,23,456.00');
    expect(formatRupees(12345600, 'plain')).toBe('1,23,456.00');
    expect(formatRupees(-50, 'rs')).toBe('-Rs. 0.50');
  });
});

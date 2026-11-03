import { describe, expect, it } from 'vitest';

import {
  formatBasisPoints,
  formatDate,
  formatIndianNumber,
  formatPaise,
  parsePaise,
} from './index';

describe('formatIndianNumber', () => {
  it('groups lakh/crore', () => {
    expect(formatIndianNumber(0)).toBe('0');
    expect(formatIndianNumber(999)).toBe('999');
    expect(formatIndianNumber(1000)).toBe('1,000');
    expect(formatIndianNumber(123456)).toBe('1,23,456');
    expect(formatIndianNumber(12345678)).toBe('1,23,45,678');
    expect(formatIndianNumber(-123456)).toBe('-1,23,456');
  });
  it('handles fractions', () => {
    expect(formatIndianNumber('1234.5', 2)).toBe('1,234.50');
  });
});

describe('formatPaise', () => {
  it('formats rupees with symbol', () => {
    expect(formatPaise(12345600)).toBe('₹1,23,456.00');
    expect(formatPaise(5)).toBe('₹0.05');
    expect(formatPaise(0)).toBe('₹0.00');
    expect(formatPaise(-150)).toBe('-₹1.50');
    expect(formatPaise(10000000000n)).toBe('₹10,00,00,000.00');
  });
  it('can omit symbol', () => {
    expect(formatPaise(100, { symbol: false })).toBe('1.00');
  });
});

describe('parsePaise', () => {
  it('parses typed input', () => {
    expect(parsePaise('1,23,456.5')).toBe(12345650n);
    expect(parsePaise('₹10')).toBe(1000n);
    expect(parsePaise('-2.05')).toBe(-205n);
    expect(parsePaise('abc')).toBeNull();
    expect(parsePaise('')).toBeNull();
  });
});

describe('misc formatters', () => {
  it('basis points', () => {
    expect(formatBasisPoints(1800)).toBe('18%');
    expect(formatBasisPoints(250)).toBe('2.5%');
  });
  it('date', () => {
    expect(formatDate(new Date(2026, 3, 5))).toBe('05-04-2026');
  });
});

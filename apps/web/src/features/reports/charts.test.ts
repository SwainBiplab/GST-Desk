import { describe, expect, it } from 'vitest';

import { barPath, compactInr, niceTicks } from './charts';

describe('chart numbers', () => {
  it('writes rupees the short Indian way, from paise', () => {
    expect(compactInr(0)).toBe('₹0');
    expect(compactInr(99_00)).toBe('₹99');
    expect(compactInr(1_000_00)).toBe('₹1K');
    expect(compactInr(45_000_00)).toBe('₹45K');
    expect(compactInr(1_20_000_00)).toBe('₹1.2L');
    expect(compactInr(12_50_000_00)).toBe('₹12.5L');
    expect(compactInr(450_000_000_000)).toBe('₹450Cr');
    expect(compactInr(3_40_00_000_00)).toBe('₹3.4Cr');
    expect(compactInr(-2_500_00)).toBe('-₹2.5K');
  });

  it('puts ticks on round numbers that cover the data, zero included', () => {
    const t = niceTicks(0, 87_500_00);
    expect(t[0]).toBe(0);
    expect(t.at(-1)!).toBeGreaterThanOrEqual(87_500_00);
    // equal steps of 1, 2, 2.5 or 5 times a power of ten
    const steps = t.slice(1).map((v, i) => v - t[i]!);
    expect(new Set(steps).size).toBe(1);
    expect(t.length).toBeLessThanOrEqual(7);
  });

  it('covers negative values too, so a month of net credit notes still fits', () => {
    const t = niceTicks(-30_000_00, 50_000_00);
    expect(t[0]!).toBeLessThanOrEqual(-30_000_00);
    expect(t.at(-1)!).toBeGreaterThanOrEqual(50_000_00);
    expect(t).toContain(0);
  });

  it('gives an empty book a sensible axis instead of dividing by zero', () => {
    expect(niceTicks(0, 0)).toEqual([0, 10_000]);
  });

  it('draws a bar flat on the baseline with a rounded data end', () => {
    const up = barPath(10, 20, 100, 40);
    expect(up.startsWith('M10,100V44')).toBe(true); // 4 px radius below the top
    expect(up.endsWith('V100Z')).toBe(true);
    const down = barPath(10, 20, 100, 160);
    expect(down.startsWith('M10,100V156')).toBe(true);
  });

  it('shrinks the corner for a short or thin bar, and skips a bar with no height', () => {
    expect(barPath(0, 20, 100, 98)).toContain('a2,2');
    expect(barPath(0, 6, 100, 10)).toContain('a3,3');
    expect(barPath(0, 20, 100, 100)).toBe('');
  });
});

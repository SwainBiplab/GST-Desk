import { describe, expect, it } from 'vitest';

import { gstinCheckChar, gstinState } from './gstin';

describe('gstin', () => {
  it('computes a known check character', () => {
    // 27AAPFU0939F1Z -> V (widely published sample GSTIN 27AAPFU0939F1ZV)
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
  });
  it('classifies input', () => {
    expect(gstinState('')).toBe('empty');
    expect(gstinState('27AAP')).toBe('incomplete');
    expect(gstinState('27aapfu0939f1zv')).toBe('valid');
    expect(gstinState('27AAPFU0939F1ZX')).toBe('bad-checksum');
    expect(gstinState('XXAAPFU0939F1ZV')).toBe('bad-format');
  });
});

import { describe, expect, it } from 'vitest';

import {
  FLAG_KEYS,
  PRESETS,
  PRESET_IDS,
  RULE_46A_DECLARATION,
  STATES,
  canIssue,
  checkGstin,
  declarationFor,
  defaultSaleType,
  deriveFlags,
  diffOverrides,
  entityType,
  gstinCheckChar,
  isPresetId,
  parseGstin,
} from '../src';

/** Build a GSTIN with a correct check character for tests. */
function make(state: string, pan: string, entity = '1') {
  const first14 = `${state}${pan}${entity}Z`;
  return first14 + gstinCheckChar(first14);
}

describe('GSTIN vectors', () => {
  const valid = make('27', 'AAPFU0939F');

  it('accepts valid numbers in any case and with spaces', () => {
    expect(checkGstin(valid)).toEqual({ valid: true, stateCode: '27', pan: 'AAPFU0939F' });
    expect(checkGstin(valid.toLowerCase()).valid).toBe(true);
    expect(checkGstin(`  ${valid} `).valid).toBe(true);
  });

  it('rejects a wrong check character', () => {
    const bad = valid.slice(0, 14) + (valid.endsWith('A') ? 'B' : 'A');
    expect(checkGstin(bad)).toEqual({ valid: false, reason: 'checksum' });
  });

  it('rejects wrong format: length, letters, the fixed Z', () => {
    for (const g of [
      '',
      '27AAPFU0939F1Z',
      '27AAPFU0939F1ZVV',
      'AAAAAAAAAAAAAAA',
      '27AAPFU0939F1AV',
      '27aapfu09391f1zv',
    ]) {
      expect(checkGstin(g), g).toMatchObject({ valid: false, reason: 'format' });
    }
  });

  it('rejects a state code that does not exist even with a good checksum', () => {
    for (const s of ['00', '25', '28', '39', '40', '98']) {
      expect(checkGstin(make(s, 'AAPFU0939F')), s).toEqual({ valid: false, reason: 'state' });
    }
  });

  it('accepts every state code in the map', () => {
    const codes = Object.keys(STATES);
    expect(codes).toHaveLength(38);
    for (const s of codes) expect(checkGstin(make(s, 'ABCDE1234F')).valid, s).toBe(true);
  });

  it('rejects a check character computed with the wrong weights', () => {
    // swap two adjacent characters of a valid GSTIN: the weighted sum changes
    const swapped = valid.slice(0, 4) + valid[5] + valid[4] + valid.slice(6);
    expect(checkGstin(swapped).valid).toBe(false);
  });
});

describe('PAN and entity type', () => {
  it('reads the taxpayer kind from the fourth letter', () => {
    expect(entityType('AAPFU0939F')).toEqual({ letter: 'F', label: 'Firm or LLP' });
    expect(entityType('abcpd1234e')).toEqual({ letter: 'P', label: 'Individual' });
    expect(entityType('AAACR5055K')?.label).toBe('Company');
    expect(entityType('AAAHM1234K')?.label).toBe('Hindu undivided family');
    expect(entityType('AAAXM1234K')).toBeNull();
    expect(entityType('')).toBeNull();
  });

  it('parses everything from a GSTIN', () => {
    const g = make('29', 'AABTT1332L', '2');
    const r = parseGstin(g);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.details).toMatchObject({
        gstin: g,
        stateCode: '29',
        stateName: 'Karnataka',
        pan: 'AABTT1332L',
        registrationNumber: '2',
      });
      expect(r.details.entity?.label).toBe('Trust');
    }
    expect(parseGstin('nonsense')).toEqual({ ok: false, reason: 'format' });
  });
});

describe('presets and feature flags', () => {
  it('defines the six presets with documents, template and units', () => {
    expect(PRESET_IDS).toHaveLength(6);
    for (const id of PRESET_IDS) {
      const p = PRESETS[id];
      expect(p.id).toBe(id);
      expect(p.documentTypes.length).toBeGreaterThan(2);
      expect(p.printTemplate).toBeTruthy();
      expect(p.units.length).toBeGreaterThan(0);
      expect(Object.keys(p.flags).sort()).toEqual([...FLAG_KEYS].sort());
    }
    expect(isPresetId('retail')).toBe(true);
    expect(isPresetId('baker')).toBe(false);
  });

  it('turns inventory and thermal on for retail and off for services', () => {
    expect(deriveFlags('retail')).toMatchObject({ inventory: true, thermal: true });
    expect(deriveFlags('services')).toMatchObject({ inventory: false, thermal: false });
    expect(deriveFlags('trader')).toMatchObject({
      inventory: true,
      challans: true,
      thermal: false,
    });
    expect(deriveFlags('freelancer').purchases).toBe(false);
    expect(deriveFlags(null).taxInvoice).toBe(true);
  });

  it('applies manual overrides on top of the preset', () => {
    expect(deriveFlags('services', 'regular', { inventory: true }).inventory).toBe(true);
    expect(deriveFlags('retail', 'regular', { thermal: false }).thermal).toBe(false);
  });

  it('lets the composition scheme override everything for tax invoices', () => {
    const f = deriveFlags('trader', 'composition', { taxInvoice: true });
    expect(f.taxInvoice).toBe(false);
    expect(f.billOfSupply).toBe(true);
    expect(f.inventory).toBe(true);
  });

  it('keeps only real differences as overrides', () => {
    const wanted = { ...deriveFlags('retail'), thermal: false, challans: true };
    expect(diffOverrides('retail', 'regular', wanted)).toEqual({ thermal: false, challans: true });
    expect(diffOverrides('retail', 'regular', deriveFlags('retail'))).toEqual({});
  });
});

describe('composition rules', () => {
  it('blocks tax invoices with an explanation and allows bills of supply', () => {
    const r = canIssue('tax_invoice', 'composition');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/composition scheme.*Bill of Supply/);
    expect(canIssue('bill_of_supply', 'composition')).toEqual({ ok: true });
    expect(canIssue('purchase_bill', 'composition')).toEqual({ ok: true });
    expect(canIssue('tax_invoice', 'regular')).toEqual({ ok: true });
  });

  it('defaults composition sales to a bill of supply with the Rule 46A text', () => {
    expect(defaultSaleType('composition')).toBe('bill_of_supply');
    expect(defaultSaleType('regular')).toBe('tax_invoice');
    expect(declarationFor('bill_of_supply', 'composition')).toBe(RULE_46A_DECLARATION);
    expect(declarationFor('bill_of_supply', 'regular')).toBeNull();
    expect(declarationFor('tax_invoice', 'composition')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import {
  PRINT_CATALOGUE,
  PRINT_LABEL_KEYS,
  PRINT_LANGUAGES,
  printLabel,
  type PrintLabelKey,
} from './print';

describe('print catalogue', () => {
  it('has every key in every language, none empty', () => {
    for (const lang of PRINT_LANGUAGES) {
      const have = Object.keys(PRINT_CATALOGUE[lang]);
      expect(have.sort(), lang).toEqual([...PRINT_LABEL_KEYS].sort());
      for (const k of PRINT_LABEL_KEYS)
        expect(PRINT_CATALOGUE[lang][k].trim(), `${lang}.${k}`).not.toBe('');
    }
  });

  it('actually translates: outside English, almost no label is left as the English word', () => {
    // a few are the same in every language (the hash sign, the Latin initials some scripts keep)
    const same = new Set<PrintLabelKey>(['sno']);
    for (const lang of PRINT_LANGUAGES.filter((l) => l !== 'en'))
      for (const k of PRINT_LABEL_KEYS)
        if (!same.has(k))
          expect(PRINT_CATALOGUE[lang][k], `${lang}.${k}`).not.toBe(PRINT_CATALOGUE.en[k]);
  });

  it('prints each language in its own script', () => {
    expect(PRINT_CATALOGUE.hi['title.tax_invoice']).toMatch(/[ऀ-ॿ]/);
    expect(PRINT_CATALOGUE.mr['title.tax_invoice']).toMatch(/[ऀ-ॿ]/);
    expect(PRINT_CATALOGUE.ta['title.tax_invoice']).toMatch(/[஀-௿]/);
    expect(PRINT_CATALOGUE.bn['title.tax_invoice']).toMatch(/[ঀ-৿]/);
    expect(PRINT_CATALOGUE.gu['title.tax_invoice']).toMatch(/[઀-૿]/);
  });

  it('uses the template override first, then the language, and never a blank', () => {
    expect(printLabel('en', 'total')).toBe('Total');
    expect(printLabel('hi', 'total')).toBe('कुल');
    expect(printLabel('en', 'total', { en: { total: 'Grand Total' } })).toBe('Grand Total');
    // an override in another language does not leak
    expect(printLabel('hi', 'total', { en: { total: 'Grand Total' } })).toBe('कुल');
  });

  it('names the three Rule 48 copies', () => {
    expect(PRINT_CATALOGUE.en['copy.original']).toBe('Original for Recipient');
    expect(PRINT_CATALOGUE.en['copy.duplicate']).toBe('Duplicate for Transporter');
    expect(PRINT_CATALOGUE.en['copy.triplicate']).toBe('Triplicate for Supplier');
  });
});

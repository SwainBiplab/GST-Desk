import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import { compare, draftFor, flatten, placeholders, type Tree } from './catalogue';
import { CONCEPTS, FROM_PRINT, OWN_TERMS, glossaryFor, term } from './glossary';
import { LOADERS } from './locales';
import { en } from './locales/en';
import { errors, help } from './locales/en-extra';
import { PRINT_CATALOGUE, PRINT_LANGUAGES, printLabel } from './print';
import { pseudo } from './pseudo';
import {
  PSEUDO,
  initialLanguage,
  isLanguage,
  loadLanguage,
  setLanguage,
  setup,
  unflatten,
} from './runtime';

const TARGETS = PRINT_LANGUAGES.filter((l) => l !== 'en');

describe('catalogue maths', () => {
  it('flattens, finds placeholders and compares', () => {
    expect(flatten({ a: { b: 'x', c: { d: 'y' } } })).toEqual({ 'a.b': 'x', 'a.c.d': 'y' });
    expect(placeholders('Hi {{name}}, {{ count }} left')).toEqual(['count', 'name']);
    const gap = compare(
      { a: 'one', b: 'two {{n}}', c: 'three', n_one: 'x', n_other: 'y' },
      { a: 'ek', b: 'do', stale: 'old', n_other: 'z' },
      new Set(['c']),
    );
    expect(gap.translated).toBe(4); // a, b (wrong placeholders), and both plural forms via the base
    expect(gap.todo).toEqual(['c']);
    expect(gap.missing).toEqual([]);
    expect(gap.placeholderMismatch.map((m) => m.key)).toEqual(['b']);
    expect(gap.orphaned).toEqual(['stale']);
  });

  it('reports a string that is neither translated nor drafted', () => {
    expect(compare({ a: 'x' }, {}).missing).toEqual(['a']);
  });

  it('drafts with glossary terms already in the language', () => {
    expect(draftFor('Show the invoice and the CGST', 'hi')).toContain(term('hi', 'cgst'));
    expect(draftFor('Show the tax invoice', 'ta')).toContain(term('ta', 'invoice'));
    expect(draftFor('Nothing to swap here', 'hi')).toBe('Nothing to swap here');
  });
});

describe('every language is accounted for', () => {
  it.each(TARGETS)('%s keeps English placeholders and has no leftovers', async (lang) => {
    const bundle = await LOADERS[lang]();
    for (const [name, english, theirs] of [
      ['ui', en, bundle.ui],
      ['errors', errors, bundle.errors ?? {}],
      ['help', help, bundle.help ?? {}],
    ] as const) {
      const gap = compare(english as Tree, theirs as Tree);
      expect(gap.placeholderMismatch, `${lang} ${name}`).toEqual([]);
      expect(gap.orphaned, `${lang} ${name}`).toEqual([]);
    }
  });

  it.each(TARGETS)('%s has every print label', (lang) => {
    for (const key of Object.keys(PRINT_CATALOGUE.en)) {
      expect(
        PRINT_CATALOGUE[lang][key as keyof typeof PRINT_CATALOGUE.en],
        `${lang} ${key}`,
      ).toBeTruthy();
    }
  });
});

describe('the glossary', () => {
  it('has a word for every concept in every language', () => {
    for (const lang of PRINT_LANGUAGES)
      for (const c of CONCEPTS) expect(term(lang, c), `${lang} ${c}`).toBeTruthy();
  });

  it('takes the words of a printed document from the print catalogue, so the two cannot differ', () => {
    for (const lang of PRINT_LANGUAGES)
      for (const [concept, key] of Object.entries(FROM_PRINT))
        expect(term(lang, concept as keyof typeof FROM_PRINT)).toBe(printLabel(lang, key));
  });

  it('names the GST terms the review asked for', () => {
    expect(term('hi', 'cgst')).toBeTruthy();
    expect(term('en', 'taxableValue')).toBe('Taxable');
    expect(term('en', 'placeOfSupply')).toBe('Place of Supply');
    expect(Object.keys(OWN_TERMS).length).toBeGreaterThan(20);
  });

  it('gives the draft tool an English-to-language map', () => {
    expect(glossaryFor('hi').get('customer')).toBe('ग्राहक');
  });
});

describe('the pseudo-locale', () => {
  it('lengthens by about 40 percent, accents letters and keeps placeholders', () => {
    const out = pseudo('Save {{count}} items now');
    expect(out).toContain('{{count}}');
    expect(out).not.toContain('Save');
    const visible = 'Save  items now'.length;
    expect(out.length).toBeGreaterThanOrEqual(
      'Save {{count}} items now'.length + Math.floor(visible * 0.35),
    );
  });
  it('leaves an empty string alone', () => {
    expect(pseudo('')).toBe('');
  });
});

describe('the runtime', () => {
  it('picks a starting language from the stored choice, then the browser, then English', () => {
    expect(initialLanguage('ta', ['hi'])).toBe('ta');
    expect(initialLanguage(null, ['xx-YY', 'hi-IN'])).toBe('hi');
    expect(initialLanguage('klingon', [])).toBe('en');
    expect(initialLanguage('pseudo', [])).toBe(PSEUDO);
    expect(isLanguage('mr')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
  });

  it('unflattens the flat print labels into paths i18next can look up', () => {
    expect(unflatten({ 'title.tax_invoice': 'A', gstin: 'B', 'copy.original': 'C' })).toEqual({
      title: { tax_invoice: 'A' },
      gstin: 'B',
      copy: { original: 'C' },
    });
  });

  it('switches language at run time, falls back to English for what is not translated, and loads print labels', async () => {
    const i18n = createInstance();
    await setup(i18n, 'en');
    expect(i18n.t('nav.sell')).toBe('Sell');

    await setLanguage(i18n, 'hi');
    expect(i18n.t('nav.sell')).toBe('बिक्री');
    expect(i18n.t('errors:boundary.title')).toBe('कुछ गड़बड़ हो गई');
    expect(i18n.t('parties.form.titleNew')).toBe('नई पार्टी');
    expect(i18n.t('title.tax_invoice', { ns: 'print' })).toBe(
      PRINT_CATALOGUE.hi['title.tax_invoice'],
    );

    await setLanguage(i18n, 'ta');
    expect(i18n.t('nav.sell')).toBe('விற்பனை');
    // not translated yet in Tamil: English, never a raw key
    expect(i18n.t('parties.form.titleNew')).toBe(en.parties.form.titleNew);
    await setLanguage(i18n, 'en');
    expect(i18n.t('nav.sell')).toBe('Sell');
  });

  it('plural forms use the language file when it has them', async () => {
    const i18n = createInstance();
    await setup(i18n, 'mr');
    expect(i18n.t('inbox.count', { count: 1 })).toBe('1 नोंद');
    expect(i18n.t('inbox.count', { count: 5 })).toBe('5 नोंदी');
  });

  it('shows English made longer under the pseudo-locale, and recovers', async () => {
    const i18n = createInstance();
    await setup(i18n, PSEUDO);
    const long = i18n.t('nav.settings');
    expect(long.length).toBeGreaterThan('Settings'.length);
    expect(long).not.toBe('Settings');
    await setLanguage(i18n, 'en');
    expect(i18n.t('nav.settings')).toBe('Settings');
  });

  it('loads a language once', async () => {
    const i18n = createInstance();
    await setup(i18n, 'en');
    await loadLanguage(i18n, 'bn');
    await loadLanguage(i18n, 'bn');
    expect(i18n.hasResourceBundle('bn', 'ui')).toBe(true);
  });
});

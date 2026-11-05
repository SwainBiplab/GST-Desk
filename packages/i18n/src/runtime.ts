/**
 * The i18next setup for the app. English is always there; another language's catalogue is fetched the
 * first time it is chosen and added to the running instance, so switching needs no reload.
 */
import type { i18n as I18n } from 'i18next';

import { LOADERS } from './locales';
import { en } from './locales/en';
import { errors, help } from './locales/en-extra';
import { PRINT_CATALOGUE, PRINT_LANGUAGES, type PrintLanguage } from './print';
import { pseudo } from './pseudo';

export const LANGUAGES = PRINT_LANGUAGES;
export type Language = PrintLanguage;
/** The layout-test language: English made longer. Reachable with `?lng=pseudo`, never offered to a person. */
export const PSEUDO = 'pseudo';

export const NAMESPACES = ['ui', 'print', 'errors', 'help'] as const;
export const DEFAULT_NS = 'ui';
export const LANGUAGE_KEY = 'gst.lang';

export const isLanguage = (v: unknown): v is Language =>
  typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);

/** `{ 'title.tax_invoice': 'x' }` to `{ title: { tax_invoice: 'x' } }`: i18next looks keys up by path. */
export function unflatten(flat: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let at = out;
    for (const part of parts.slice(0, -1)) {
      const next = at[part];
      if (typeof next === 'object' && next !== null) at = next as Record<string, unknown>;
      else {
        const made: Record<string, unknown> = {};
        at[part] = made;
        at = made;
      }
    }
    at[parts[parts.length - 1]!] = value;
  }
  return out;
}

/** The language to start in: the one chosen on this device, else the browser's, else English. */
export function initialLanguage(
  stored: string | null | undefined,
  browser: readonly string[] = [],
): Language | typeof PSEUDO {
  if (stored === PSEUDO) return PSEUDO;
  if (isLanguage(stored)) return stored;
  for (const b of browser) {
    const base = b.toLowerCase().split('-')[0];
    if (isLanguage(base)) return base;
  }
  return 'en';
}

function addEnglish(i18n: I18n) {
  i18n.addResourceBundle('en', 'ui', en, true, true);
  i18n.addResourceBundle('en', 'errors', errors, true, true);
  i18n.addResourceBundle('en', 'help', help, true, true);
}

function addPrint(i18n: I18n, lng: Language) {
  i18n.addResourceBundle(lng, 'print', unflatten(PRINT_CATALOGUE[lng]), true, true);
}

/** Make a language's catalogue available (a no-op for English and for ones already loaded). */
export async function loadLanguage(i18n: I18n, lng: Language | typeof PSEUDO): Promise<void> {
  const code = lng === PSEUDO ? 'en' : lng;
  if (code === 'en') return;
  if (i18n.hasResourceBundle(code, 'ui')) return;
  const bundle = await LOADERS[code]();
  i18n.addResourceBundle(code, 'ui', bundle.ui, true, true);
  if (bundle.errors) i18n.addResourceBundle(code, 'errors', bundle.errors, true, true);
  if (bundle.help) i18n.addResourceBundle(code, 'help', bundle.help, true, true);
  addPrint(i18n, code);
}

/** Start i18next with English loaded and `lng` selected. */
export async function setup(i18n: I18n, lng: Language | typeof PSEUDO = 'en'): Promise<void> {
  await i18n.init({
    lng: 'en',
    fallbackLng: 'en',
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NS,
    resources: {},
    interpolation: { escapeValue: false },
    postProcess: false,
  });
  addEnglish(i18n);
  for (const l of LANGUAGES) addPrint(i18n, l);
  i18n.use({
    type: 'postProcessor',
    name: PSEUDO,
    process: (value: string) => pseudo(value),
  });
  await setLanguage(i18n, lng);
}

/** Switch the language the screens speak, without a reload. */
export async function setLanguage(i18n: I18n, lng: Language | typeof PSEUDO): Promise<void> {
  await loadLanguage(i18n, lng);
  const real = lng === PSEUDO ? 'en' : lng;
  await i18n.changeLanguage(real);
  i18n.options.postProcess = lng === PSEUDO ? [PSEUDO] : false;
}

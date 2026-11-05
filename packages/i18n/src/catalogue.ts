/**
 * Catalogue maths shared by the tools and the tests: flatten a nested catalogue into dotted keys,
 * find what a language lacks, and check a translation keeps the placeholders of its English source.
 */
import { glossaryFor } from './glossary';
import type { PrintLanguage } from './print';

export type Tree = { [key: string]: string | Tree };

/** `{ a: { b: 'x' } }` to `{ 'a.b': 'x' }`. */
export function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}

/** The `{{name}}` placeholders in a string, sorted. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!).sort();
}

const PLURAL = /_(zero|one|two|few|many|other)$/;

/** English plural keys have forms the target language may express differently; compare by base. */
const base = (key: string) => key.replace(PLURAL, '');

export interface Gap {
  /** In English, not translated and not drafted. */
  missing: string[];
  /** Drafted and waiting for a translator. */
  todo: string[];
  /** Translated, but with different placeholders from English. */
  placeholderMismatch: { key: string; en: string[]; translated: string[] }[];
  /** In the language but not in English: left over from a string that was removed. */
  orphaned: string[];
  translated: number;
  total: number;
}

/**
 * Compare a language with English. `todo` is the set of keys a draft exists for (they count as
 * accounted for, not as translated). A plural base is satisfied by any of its forms.
 */
export function compare(en: Tree, lang: Tree, todo: ReadonlySet<string> = new Set()): Gap {
  const e = flatten(en);
  const l = flatten(lang);
  const haveBase = new Set(Object.keys(l).map(base));
  const gap: Gap = {
    missing: [],
    todo: [],
    placeholderMismatch: [],
    orphaned: [],
    translated: 0,
    total: Object.keys(e).length,
  };
  for (const [key, text] of Object.entries(e)) {
    if (key in l) {
      gap.translated += 1;
      const a = placeholders(text).join('|');
      const b = placeholders(l[key]!).join('|');
      if (a !== b)
        gap.placeholderMismatch.push({
          key,
          en: placeholders(text),
          translated: placeholders(l[key]!),
        });
    } else if (PLURAL.test(key) && haveBase.has(base(key))) {
      gap.translated += 1;
    } else if (todo.has(key)) gap.todo.push(key);
    else gap.missing.push(key);
  }
  for (const key of Object.keys(l)) if (!(key in e) && !PLURAL.test(key)) gap.orphaned.push(key);
  return gap;
}

/** A draft for a translator: the English text with glossary terms already in the language, flagged as a draft. */
export function draftFor(text: string, lang: PrintLanguage): string {
  const terms = [...glossaryFor(lang)].sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [english, native] of terms) {
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), native);
  }
  return out;
}

export interface TodoEntry {
  en: string;
  draft: string;
  status: 'todo';
}

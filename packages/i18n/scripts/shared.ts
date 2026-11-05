import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Tree, TodoEntry } from '../src/catalogue';
import { LOADERS } from '../src/locales';
import { en } from '../src/locales/en';
import { errors, help } from '../src/locales/en-extra';
import { PRINT_LANGUAGES, type PrintLanguage } from '../src/print';

export const root = join(import.meta.dirname, '..');
export const TARGETS = PRINT_LANGUAGES.filter((l): l is Exclude<PrintLanguage, 'en'> => l !== 'en');
export const NS = ['ui', 'errors', 'help'] as const;
export type Ns = (typeof NS)[number];

export const ENGLISH: Record<Ns, Tree> = {
  ui: en as Tree,
  errors: errors as Tree,
  help: help as Tree,
};

export async function loadLanguage(lang: Exclude<PrintLanguage, 'en'>): Promise<Record<Ns, Tree>> {
  const b = await LOADERS[lang]();
  return { ui: b.ui as Tree, errors: (b.errors ?? {}) as Tree, help: (b.help ?? {}) as Tree };
}

export const todoPath = (lang: string) => join(root, 'locales-todo', `${lang}.json`);

export type TodoFile = Partial<Record<Ns, Record<string, TodoEntry>>>;

export function loadTodo(lang: string): TodoFile {
  const p = todoPath(lang);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as TodoFile) : {};
}

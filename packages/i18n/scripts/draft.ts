/**
 * pnpm i18n:draft. For every string a language lacks, writes a draft to locales-todo/<lang>.json:
 * the English text with the glossary's terms already in that language, marked `todo`. It uses only the
 * local glossary: no network. A translator replaces a draft by adding the real string to the language
 * file; the next run drops it from the todo list. Drafts are never shown in the app.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { compare, draftFor, flatten, type TodoEntry } from '../src/catalogue';

import { ENGLISH, NS, TARGETS, loadLanguage, todoPath, type TodoFile } from './shared';

for (const lang of TARGETS) {
  const bundle = await loadLanguage(lang);
  const out: TodoFile = {};
  let n = 0;
  for (const ns of NS) {
    const gap = compare(ENGLISH[ns], bundle[ns]);
    const english = flatten(ENGLISH[ns]);
    const entries: Record<string, TodoEntry> = {};
    for (const key of gap.missing) {
      entries[key] = { en: english[key]!, draft: draftFor(english[key]!, lang), status: 'todo' };
      n += 1;
    }
    if (Object.keys(entries).length > 0) out[ns] = entries;
  }
  mkdirSync(dirname(todoPath(lang)), { recursive: true });
  // one line per string, so a diff shows what changed
  const body =
    '{\n' +
    Object.entries(out)
      .map(
        ([ns, entries]) =>
          `  ${JSON.stringify(ns)}: {\n` +
          Object.entries(entries)
            .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
            .join(',\n') +
          '\n  }',
      )
      .join(',\n') +
    '\n}\n';
  writeFileSync(todoPath(lang), body);
  console.log(`${lang}: ${n} drafts`);
}

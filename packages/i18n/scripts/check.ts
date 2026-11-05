/**
 * pnpm i18n:check. Fails when a language lacks a string that English has and no draft exists for,
 * when a translation changed a {{placeholder}}, or when a language keeps a string English removed.
 * Strings that are only drafted (waiting for a translator) pass and are counted.
 */
import { compare } from '../src/catalogue';

import { ENGLISH, NS, TARGETS, loadLanguage, loadTodo } from './shared';

let failed = false;
const rows: string[] = [];
for (const lang of TARGETS) {
  const bundle = await loadLanguage(lang);
  const todo = loadTodo(lang);
  let translated = 0;
  let total = 0;
  let drafted = 0;
  for (const ns of NS) {
    const gap = compare(ENGLISH[ns], bundle[ns], new Set(Object.keys(todo[ns] ?? {})));
    translated += gap.translated;
    total += gap.total;
    drafted += gap.todo.length;
    for (const k of gap.missing) {
      failed = true;
      console.error(`${lang}: ${ns}:${k} is missing (run pnpm i18n:draft)`);
    }
    for (const m of gap.placeholderMismatch) {
      failed = true;
      console.error(
        `${lang}: ${ns}:${m.key} placeholders {${m.translated}} differ from English {${m.en}}`,
      );
    }
    for (const k of gap.orphaned) {
      failed = true;
      console.error(`${lang}: ${ns}:${k} is not in English any more`);
    }
  }
  rows.push(
    `${lang}  translated ${translated}/${total} (${Math.round((translated / total) * 100)}%)  drafted ${drafted}`,
  );
}
console.log(rows.join('\n'));
if (failed) {
  console.error('\ni18n:check failed');
  process.exit(1);
}
console.log('\ni18n:check passed: every string is translated or has a draft waiting for review');

/**
 * pnpm i18n:extract. Finds every key the app asks for (t('nav.sell'), t('errors:val.x'), and
 * template keys such as nav.${page}) and fails when a literal key is not in English: a typo, or a
 * string that was never added. A template key counts as using everything under its prefix. Prints how
 * many English strings nothing seems to use (information only: keys can also be passed around as data).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { flatten } from '../src/catalogue';

import { ENGLISH, root } from './shared';

const SRC = join(root, '..', '..', 'apps', 'web', 'src');
const EXTRA = [join(root, '..', 'ui', 'src')];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) && !/\.(test|spec|stories)\./.test(f) ? [p] : [];
  });
}

const CALL = /\b(?:t|i18n\.t)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

const known: Record<string, Set<string>> = {};
for (const [ns, tree] of Object.entries(ENGLISH)) known[ns] = new Set(Object.keys(flatten(tree)));

const hasKey = (ns: string, key: string) => {
  const set = known[ns];
  return !!set && (set.has(key) || set.has(`${key}_one`) || set.has(`${key}_other`));
};

const literal: { file: string; ns: string; key: string }[] = [];
const prefixes: { ns: string; prefix: string }[] = [];

for (const file of [SRC, ...EXTRA].flatMap((d) => files(d))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(CALL)) {
    const raw = m[2]!;
    const withNs = /^[a-z]+:/.test(raw);
    const ns = withNs ? raw.slice(0, raw.indexOf(':')) : 'ui';
    const key = withNs ? raw.slice(raw.indexOf(':') + 1) : raw;
    if (m[1] === '`' && key.includes('${')) {
      prefixes.push({ ns, prefix: key.slice(0, key.indexOf('${')) });
    } else if (/^[\w.]+$/.test(key) && key.includes('.')) {
      literal.push({ file: file.replace(SRC, 'apps/web/src'), ns, key });
    }
  }
}

const unknown = literal.filter((l) => known[l.ns] && !hasKey(l.ns, l.key));
const used = new Set(literal.map((l) => `${l.ns}:${l.key}`));
const unused: string[] = [];
for (const [ns, set] of Object.entries(known))
  for (const key of set) {
    const baseKey = key.replace(/_(zero|one|two|few|many|other)$/, '');
    if (used.has(`${ns}:${key}`) || used.has(`${ns}:${baseKey}`)) continue;
    if (prefixes.some((p) => p.ns === ns && key.startsWith(p.prefix))) continue;
    unused.push(`${ns}:${key}`);
  }

console.log(
  `${literal.length} literal keys, ${prefixes.length} dynamic prefixes, ${unused.length} English strings nothing seems to use`,
);
if (process.argv.includes('--unused')) console.log(unused.join('\n'));
if (unknown.length > 0) {
  for (const u of unknown) console.error(`${u.file}: unknown key ${u.ns}:${u.key}`);
  console.error('\ni18n:extract failed: add the strings to English or fix the keys');
  process.exit(1);
}
console.log('i18n:extract passed: every key the app asks for exists in English');

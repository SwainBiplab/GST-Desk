/**
 * pnpm ai:eval --provider mock [--schema purchaseBill]
 * Runs a provider over fixtures/<schema>/*.json and prints field-level accuracy. Always exits 0
 * unless the arguments are invalid.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  InMemoryHsnLookup,
  MockProvider,
  RulesProvider,
  SCHEMAS,
  formatReports,
  runEval,
  type AiProvider,
  type EvalCase,
  type SchemaName,
} from '../src';

const root = join(import.meta.dirname, '..', 'fixtures');
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) args.set(a.slice(2), argv[i + 1] ?? '');
}

const providerName = args.get('provider') ?? 'mock';
const only = args.get('schema');
const MODE: Record<SchemaName, 'extract' | 'suggest'> = {
  purchaseBill: 'extract',
  hsnSuggestion: 'suggest',
};

const names = (only ? [only] : Object.keys(SCHEMAS)) as SchemaName[];
for (const n of names) {
  if (!(n in SCHEMAS)) {
    console.error(`unknown schema "${n}". Known: ${Object.keys(SCHEMAS).join(', ')}`);
    process.exit(2);
  }
}
if (!['mock', 'rules'].includes(providerName)) {
  console.error(`unknown provider "${providerName}". Offline providers: mock, rules`);
  process.exit(2);
}

function loadCases(schema: string): EvalCase[] {
  const dir = join(root, schema);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalCase);
}

const hsn = JSON.parse(readFileSync(join(root, 'hsn-master.json'), 'utf8'));
const reports = [];
for (const name of names) {
  const cases = loadCases(name);
  let provider: AiProvider;
  if (providerName === 'mock') {
    const byInput = new Map(cases.map((c) => [JSON.stringify(c.input), c.mock ?? c.expected]));
    provider = new MockProvider({ [name]: (input: unknown) => byInput.get(JSON.stringify(input)) });
  } else {
    provider = new RulesProvider({ hsn: new InMemoryHsnLookup(hsn) });
  }
  reports.push(
    await runEval({ provider, schemaName: name, schema: SCHEMAS[name], mode: MODE[name], cases }),
  );
}
console.log(formatReports(reports));

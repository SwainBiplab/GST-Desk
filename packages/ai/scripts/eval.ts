/**
 * pnpm ai:eval --provider mock [--schema purchaseBill]
 * Runs a provider over fixtures/<schema>/*.json and prints field-level accuracy. Always exits 0
 * unless the arguments are invalid.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  InMemoryHsnLookup,
  MockProvider,
  RulesProvider,
  SCHEMAS,
  formatReports,
  hsnCasesFromAccepted,
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

/** --accepted <file.sqlite>: also score against what this device's user accepted in the inbox (read only). */
function acceptedCases(schema: string): EvalCase[] {
  const file = args.get('accepted');
  if (!file || schema !== 'hsnSuggestion') return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT kind, suggestion_json, correction_json FROM review_items WHERE status = 'accepted' AND kind = 'hsn_suggestion' AND deleted_at IS NULL",
      )
      .all() as { kind: string; suggestion_json: string; correction_json: string | null }[];
    return hsnCasesFromAccepted(
      rows.map((r) => ({
        kind: r.kind,
        suggestion_json: JSON.parse(r.suggestion_json),
        correction_json: r.correction_json ? JSON.parse(r.correction_json) : null,
      })),
    );
  } finally {
    db.close();
  }
}

function loadCases(schema: string): EvalCase[] {
  const dir = join(root, schema);
  return [
    ...readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalCase),
    ...acceptedCases(schema),
  ];
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

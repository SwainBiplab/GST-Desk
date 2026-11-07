/**
 * pnpm ai:eval --provider mock|rules|ollama|llama [--schema purchaseBill] [--model name] [--url http://...]
 *              [--accepted file.sqlite] [--markdown]
 * Runs a provider over the fixtures and prints field-level accuracy and latency. Always exits 0 unless the
 * arguments are invalid. `ollama` and `llama` need a server already running at `--url`; nothing is started.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  InMemoryHsnLookup,
  LocalLlamaProvider,
  MockProvider,
  OllamaProvider,
  RulesProvider,
  SCHEMAS,
  formatReports,
  hsnCasesFromAccepted,
  runEval,
  withTier0Local,
  type AiProvider,
  type EvalCase,
  type EvalReport,
  type Keeper,
  type SchemaName,
} from '../src';

const root = join(import.meta.dirname, '..', 'fixtures');
const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) {
    const next = argv[i + 1];
    args.set(a.slice(2), next && !next.startsWith('--') ? next : '');
  }
}

const providerName = args.get('provider') ?? 'mock';
const only = args.get('schema');
const MODE: Record<SchemaName, 'extract' | 'suggest'> = {
  purchaseBill: 'extract',
  hsnSuggestion: 'suggest',
  voiceDraft: 'suggest',
};
/** Where each schema's cases live (several folders are read in order). */
const DIRS: Record<SchemaName, string[]> = {
  purchaseBill: ['purchaseBill', 'bills', 'bills/real'],
  hsnSuggestion: ['hsnSuggestion'],
  voiceDraft: ['voiceDraft'],
};

const names = (only ? [only] : Object.keys(SCHEMAS)) as SchemaName[];
for (const n of names) {
  if (!(n in SCHEMAS)) {
    console.error(`unknown schema "${n}". Known: ${Object.keys(SCHEMAS).join(', ')}`);
    process.exit(2);
  }
}
if (!['mock', 'rules', 'ollama', 'llama'].includes(providerName)) {
  console.error(`unknown provider "${providerName}". Providers: mock, rules, ollama, llama`);
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

function loadCases(schema: SchemaName): EvalCase[] {
  const out: EvalCase[] = [];
  for (const d of DIRS[schema]) {
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith('.json'))
      .sort())
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalCase);
  }
  return [...out, ...acceptedCases(schema)];
}

/** A keeper over a server that is already running: nothing to start or stop. */
const runningAt = (baseUrl: string): Keeper => ({
  withServer: (fn) => fn({ baseUrl }),
  stop: async () => undefined,
  running: () => true,
});

const hsn = JSON.parse(readFileSync(join(root, 'hsn-master.json'), 'utf8'));
const reports: EvalReport[] = [];
for (const name of names) {
  const cases = loadCases(name);
  let provider: AiProvider;
  if (providerName === 'mock') {
    const byInput = new Map(cases.map((c) => [JSON.stringify(c.input), c.mock ?? c.expected]));
    provider = new MockProvider({ [name]: (input: unknown) => byInput.get(JSON.stringify(input)) });
  } else if (providerName === 'rules') {
    const rateByCode = new Map<string, number>(
      (hsn as { code: string; rate_bp: number }[]).map((h) => [h.code, h.rate_bp]),
    );
    provider = withTier0Local(new RulesProvider({ hsn: new InMemoryHsnLookup(hsn) }), {
      rateForHsn: (code) => rateByCode.get(code) ?? null,
    });
  } else if (providerName === 'ollama') {
    provider = new OllamaProvider({
      model: args.get('model') || 'qwen2.5:1.5b',
      ...(args.get('url') ? { baseUrl: args.get('url')! } : {}),
    });
  } else {
    provider = new LocalLlamaProvider({
      llm: runningAt(args.get('url') || 'http://127.0.0.1:8080'),
      modelName: args.get('model') || 'llama-server',
    });
  }
  if (!provider.capabilities().has(MODE[name])) {
    console.error(`${providerName} cannot ${MODE[name]} (${name}); skipped`);
    continue;
  }
  reports.push(
    await runEval({ provider, schemaName: name, schema: SCHEMAS[name], mode: MODE[name], cases }),
  );
}

if (args.has('markdown')) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  for (const r of reports) {
    console.log(
      `### ${r.schema} with \`${providerName}\`${args.get('model') ? ` (${args.get('model')})` : ''}\n`,
    );
    console.log(
      `| cases | errors | accuracy | avg latency |\n| --- | --- | --- | --- |\n| ${r.cases} | ${r.failures} | ${pct(r.accuracy)} | ${r.avgLatencyMs} ms |\n`,
    );
    console.log('| field | correct | of |\n| --- | --- | --- |');
    for (const f of r.fields) console.log(`| \`${f.field}\` | ${f.correct} | ${f.total} |`);
    console.log('');
  }
} else console.log(formatReports(reports));

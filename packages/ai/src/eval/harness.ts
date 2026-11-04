/** Field-level accuracy harness. No file access here; the CLI loads fixtures. */
import type { AiDocument, AiPrompt, AiProvider, Schema } from '../provider';

export interface EvalCase {
  name: string;
  /** An `AiDocument` (extract) or `AiPrompt` (suggest). */
  input: unknown;
  /** Expected output. May be partial: only the leaves present are scored. */
  expected: unknown;
  /** Canned provider output for the mock backend (defaults to `expected`). */
  mock?: unknown;
}

export interface FieldScore {
  field: string;
  correct: number;
  total: number;
}

export interface EvalReport {
  schema: string;
  provider: string;
  cases: number;
  /** Cases where the provider returned an error. */
  failures: number;
  fields: FieldScore[];
  /** Correct leaves / expected leaves, 0..1. */
  accuracy: number;
  avgLatencyMs: number;
}

/** Flatten to `path -> primitive` (arrays by index). */
export function leaves(value: unknown, path = ''): Record<string, unknown> {
  if (Array.isArray(value)) {
    return Object.assign({}, ...value.map((v, i) => leaves(v, path ? `${path}.${i}` : String(i))));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.assign(
      {},
      ...Object.entries(value).map(([k, v]) => leaves(v, path ? `${path}.${k}` : k)),
    );
  }
  return { [path]: value };
}

const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

/** Strip array indices so `lines.0.hsn` and `lines.1.hsn` score as one field. */
const fieldName = (path: string) => path.replace(/\.\d+(?=\.|$)/g, '[]');

export async function runEval(args: {
  provider: AiProvider;
  schemaName: string;
  schema: Schema<unknown>;
  mode: 'extract' | 'suggest';
  cases: EvalCase[];
}): Promise<EvalReport> {
  const { provider, schemaName, schema, mode, cases } = args;
  const scores = new Map<string, FieldScore>();
  let failures = 0;
  let latency = 0;
  let ran = 0;

  for (const c of cases) {
    const started = performance.now();
    const r =
      mode === 'extract'
        ? await provider.extract(c.input as AiDocument, schema, { schemaName, feature: schemaName })
        : await provider.suggest(c.input as AiPrompt, schema, { schemaName });
    latency += r.ok ? r.latencyMs || performance.now() - started : performance.now() - started;
    ran += 1;
    const want = leaves(c.expected);
    const got = r.ok ? leaves(r.value) : {};
    if (!r.ok) failures += 1;
    for (const [path, expected] of Object.entries(want)) {
      const key = fieldName(path);
      const s = scores.get(key) ?? { field: key, correct: 0, total: 0 };
      s.total += 1;
      if (r.ok && path in got && norm(got[path]) === norm(expected)) s.correct += 1;
      scores.set(key, s);
    }
  }

  const fields = [...scores.values()].sort((a, b) => a.field.localeCompare(b.field));
  const total = fields.reduce((a, f) => a + f.total, 0);
  const correct = fields.reduce((a, f) => a + f.correct, 0);
  return {
    schema: schemaName,
    provider: provider.id,
    cases: cases.length,
    failures,
    fields,
    accuracy: total === 0 ? 0 : correct / total,
    avgLatencyMs: ran === 0 ? 0 : Math.round(latency / ran),
  };
}

/** Plain-text table for the CLI. */
export function formatReports(reports: EvalReport[]): string {
  const lines: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  lines.push(
    'schema'.padEnd(16) +
      'provider'.padEnd(10) +
      'cases'.padStart(6) +
      'errors'.padStart(8) +
      'accuracy'.padStart(10) +
      'avg ms'.padStart(8),
  );
  for (const r of reports) {
    lines.push(
      r.schema.padEnd(16) +
        r.provider.padEnd(10) +
        String(r.cases).padStart(6) +
        String(r.failures).padStart(8) +
        pct(r.accuracy).padStart(10) +
        String(r.avgLatencyMs).padStart(8),
    );
    for (const f of r.fields) {
      lines.push(`  ${f.field.padEnd(30)} ${f.correct}/${f.total}`);
    }
  }
  return lines.join('\n');
}

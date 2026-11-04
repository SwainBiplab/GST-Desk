/** Calculation trace: every engine function returns its result plus the steps that produced it. */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface TraceStep {
  /** Stable rule id, e.g. `line.taxable` or `tcs.206C1H`. */
  rule: string;
  inputs: Record<string, Json>;
  output: Json;
  /** Human-readable explanation for the trace panel. */
  note: string;
}

export interface Traced<T> {
  result: T;
  trace: TraceStep[];
}

/** Convert values to JSON-safe form (bigint becomes a decimal string). */
export function toJson(v: unknown): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toJson(x)]),
    );
  }
  return String(v);
}

export function step(
  rule: string,
  inputs: Record<string, unknown>,
  output: unknown,
  note: string,
): TraceStep {
  return { rule, inputs: toJson(inputs) as Record<string, Json>, output: toJson(output), note };
}

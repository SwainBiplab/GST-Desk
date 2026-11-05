/**
 * Turn accepted review items into eval fixtures (local only: nothing leaves the device). An item the
 * person accepted as-is says "the rule was right"; one they edited says what the right answer was.
 */
import type { DiffEntry } from '../diff';
import type { EvalCase } from '../eval/harness';

/** Apply the user's recorded edits (`correction_json`) on top of the original suggestion. */
export function applyCorrection(suggestion: unknown, correction: unknown): unknown {
  const root = structuredClone(suggestion) as Record<string, unknown>;
  if (!Array.isArray(correction)) return root;
  for (const e of correction as DiffEntry[]) {
    if (!e.path) return e.after;
    const parts = e.path.split('.');
    let at: any = root;
    for (const p of parts.slice(0, -1)) {
      at = at?.[p];
      if (at == null) break;
    }
    if (at == null) continue;
    const last = parts[parts.length - 1]!;
    if (e.op === 'remove') Reflect.deleteProperty(at, last);
    else at[last] = e.after;
  }
  return root;
}

export interface AcceptedRow {
  kind: string;
  suggestion_json: unknown;
  correction_json?: unknown;
}

/** HSN suggestions the person accepted become `hsnSuggestion` cases: the final code is what is expected. */
export function hsnCasesFromAccepted(rows: readonly AcceptedRow[]): EvalCase[] {
  const out: EvalCase[] = [];
  for (const r of rows) {
    if (r.kind !== 'hsn_suggestion') continue;
    const final = applyCorrection(r.suggestion_json, r.correction_json) as {
      itemName?: string;
      code?: string;
    };
    if (!final.itemName || !final.code) continue;
    out.push({
      name: `accepted: ${final.itemName}`,
      input: { feature: 'hsn_lookup', input: { description: final.itemName, limit: 3 } },
      expected: { suggestions: [{ code: final.code }] },
    });
  }
  return out;
}

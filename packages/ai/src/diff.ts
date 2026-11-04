/** Small structural JSON diff used for review items and corrections. Browser-safe. */

export interface DiffEntry {
  /** Dot path, arrays by index: `lines.0.hsn`. Empty string = the root. */
  path: string;
  op: 'add' | 'remove' | 'change';
  before?: unknown;
  after?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function jsonDiff(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: DiffEntry[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      const p = path ? `${path}.${i}` : String(i);
      if (i >= before.length) out.push({ path: p, op: 'add', after: after[i] });
      else if (i >= after.length) out.push({ path: p, op: 'remove', before: before[i] });
      else out.push(...jsonDiff(before[i], after[i], p));
    }
    return out;
  }
  if (isObj(before) && isObj(after)) {
    const out: DiffEntry[] = [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in before)) out.push({ path: p, op: 'add', after: after[k] });
      else if (!(k in after)) out.push({ path: p, op: 'remove', before: before[k] });
      else out.push(...jsonDiff(before[k], after[k], p));
    }
    return out;
  }
  return Object.is(before, after) || before === after
    ? []
    : [{ path, op: 'change', before, after }];
}

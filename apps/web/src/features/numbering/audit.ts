import { toCsv, type CsvValue } from '@gst/domain';

/** Columns that change on every write and say nothing about what the user did. */
const NOISE = new Set([
  'version',
  'updated_at',
  'updated_by',
  'created_at',
  'created_by',
  'org_id',
]);

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

/** A value as one line of text, for a diff or a spreadsheet. */
export function showValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === 'object' || typeof b === 'object') {
    // key order differs between databases, so compare sorted
    const norm = (x: unknown): string =>
      JSON.stringify(x, (_k, y) =>
        y && typeof y === 'object' && !Array.isArray(y)
          ? Object.fromEntries(Object.entries(y as object).sort(([p], [q]) => p.localeCompare(q)))
          : y,
      );
    return norm(a) === norm(b);
  }
  return String(a) === String(b);
};

/** The fields that differ between two row snapshots (all fields for an insert or a removal). */
export function diffRows(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): FieldChange[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: FieldChange[] = [];
  for (const field of [...keys].sort()) {
    if (NOISE.has(field)) continue;
    const a = before?.[field];
    const b = after?.[field];
    if (same(a, b)) continue;
    out.push({ field, before: showValue(a), after: showValue(b) });
  }
  return out;
}

export interface AuditEntry {
  id: string;
  table_name: string;
  row_id: string;
  action: 'insert' | 'update' | 'soft_delete';
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  actor: string;
  at: number;
}

/** The audit trail as a spreadsheet: one row per changed field, so a filter in Excel finds a value. */
export function auditCsv(entries: readonly AuditEntry[]): string {
  const rows: CsvValue[][] = [
    ['When', 'Who', 'Record type', 'Record id', 'Action', 'Field', 'Before', 'After'],
  ];
  for (const e of entries) {
    const when = new Date(e.at).toISOString();
    const changes = diffRows(e.before_json, e.after_json);
    if (changes.length === 0)
      rows.push([when, e.actor, e.table_name, e.row_id, e.action, '', '', '']);
    for (const c of changes)
      rows.push([when, e.actor, e.table_name, e.row_id, e.action, c.field, c.before, c.after]);
  }
  return toCsv(rows);
}

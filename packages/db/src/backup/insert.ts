import type { Database } from '../database';

import type { TableInfo } from './tables';

/** SQLite allows at most 32,766 bound values in one statement; stay well under it. */
const MAX_VALUES = 30_000;

/**
 * Put rows in an order a table that points at itself accepts: a row after the row it points at.
 * Rows pointing at something outside the set (or at nothing) keep their place.
 */
export function orderForInsert(
  table: TableInfo,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const selfCols = Object.entries(table.refs)
    .filter(([, target]) => target === table.name)
    .map(([col]) => col);
  if (selfCols.length === 0) return rows;
  const byId = new Map(rows.map((r) => [String(r['id']), r]));
  const done = new Set<string>();
  const out: Record<string, unknown>[] = [];
  const visit = (row: Record<string, unknown>, depth: number) => {
    const id = String(row['id']);
    if (done.has(id)) return;
    done.add(id);
    if (depth < 10_000) {
      for (const col of selfCols) {
        const parent = row[col] == null ? undefined : byId.get(String(row[col]));
        if (parent) visit(parent, depth + 1);
      }
    }
    out.push(row);
  };
  for (const r of rows) visit(r, 0);
  return out;
}

/** Insert rows of one table in batches. Columns the schema does not have are dropped. */
export async function insertRows(
  d: Database,
  tx: any,
  table: TableInfo,
  rows: Record<string, unknown>[],
  yieldToUi?: () => Promise<void>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const t = d.schema[table.name as keyof typeof d.schema];
  const width = Math.max(1, Object.keys(rows[0]!).length);
  const batch = Math.max(1, Math.floor(MAX_VALUES / width));
  const known = new Set(Object.keys(table.columns));
  const clean = (r: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => known.has(k)));
  let inserted = 0;
  for (let at = 0; at < rows.length; at += batch) {
    const slice = rows.slice(at, at + batch).map(clean);
    await tx.insert(t).values(slice);
    inserted += slice.length;
    if (yieldToUi && at + batch < rows.length) await yieldToUi();
  }
  return inserted;
}

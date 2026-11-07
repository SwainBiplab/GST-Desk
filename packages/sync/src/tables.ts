/**
 * PowerSync "raw tables": the synced rows go straight into our own tables (with their constraints,
 * indexes and search triggers), not into PowerSync's JSON views. A row from the server is an upsert,
 * so update triggers (search) run as for any local edit; a delete is a delete.
 */
import { SYNC_TABLES, UPLOAD_TABLES, syncColumns } from '@gst/db';

/** Append-only tables: a row the device already has (it wrote it) is never rewritten. */
const APPEND_ONLY = new Set(SYNC_TABLES.filter((t) => t.appendOnly).map((t) => t.name));

export interface RawTableDef {
  put: { sql: string; params: ({ Column: string } | 'Id')[] };
  delete: { sql: string; params: 'Id'[] };
  schema: { tableName: string; trackPrevious?: { columns: string[] } };
}

export function rawTables(): Record<string, RawTableDef> {
  const out: Record<string, RawTableDef> = {};
  for (const t of SYNC_TABLES) {
    const cols = syncColumns(t.name);
    const rest = cols.filter((c) => c !== 'id');
    const names = cols.map((c) => `"${c}"`).join(', ');
    const marks = cols.map(() => '?').join(', ');
    const set = rest.map((c) => `"${c}" = excluded."${c}"`).join(', ');
    out[t.name] = {
      put: {
        sql: APPEND_ONLY.has(t.name)
          ? `INSERT INTO "${t.name}" (${names}) VALUES (${marks}) ON CONFLICT(id) DO NOTHING`
          : `INSERT INTO "${t.name}" (${names}) VALUES (${marks}) ON CONFLICT(id) DO UPDATE SET ${set}`,
        params: cols.map((c) => (c === 'id' ? 'Id' : { Column: c })),
      },
      delete: { sql: `DELETE FROM "${t.name}" WHERE id = ?`, params: ['Id'] },
      // the version and time the device's change started from: how the server tells a change made on
      // top of what it holds from one made on top of something else
      schema: {
        tableName: t.name,
        ...(cols.includes('version') && cols.includes('updated_at')
          ? { trackPrevious: { columns: ['version', 'updated_at'] } }
          : {}),
      },
    };
  }
  return out;
}

/** Tables whose local writes are queued for upload. */
export const UPLOADED = new Set(UPLOAD_TABLES);

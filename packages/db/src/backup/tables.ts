/**
 * What a backup is made of: every table, in an order that lets rows be inserted without breaking a
 * foreign key, and how a stored value turns into a portable one and back. Built from the schema spec,
 * so a new table or column is in the backup the day it is added.
 */
import { SPEC, tableColumns, type Col, type TableKind } from '../schema';

export interface TableInfo {
  name: string;
  kind: TableKind;
  /** Every column, in spec order. */
  columns: Record<string, Col>;
  /** Column to the table it points at, for the columns that are foreign keys. */
  refs: Record<string, string>;
}

export const TABLES: TableInfo[] = SPEC.map((spec) => {
  const columns = tableColumns(spec);
  const refs: Record<string, string> = {};
  for (const [k, col] of Object.entries(columns)) if (col.o.ref) refs[k] = col.o.ref;
  return { name: spec.name, kind: spec.kind, columns, refs };
});

export const tableInfo = (name: string): TableInfo => {
  const t = TABLES.find((x) => x.name === name);
  if (!t) throw new Error(`unknown table ${name}`);
  return t;
};

/**
 * Tables with parents first. Self-references (a ledger account's parent) are ignored here and handled
 * by ordering rows inside the table. Throws if two tables point at each other, which would make an
 * insert order impossible without deferring constraints.
 */
export function tableOrder(): string[] {
  const out: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, trail: string[]) => {
    const s = state.get(name);
    if (s === 'done') return;
    if (s === 'visiting')
      throw new Error(`tables point at each other: ${[...trail, name].join(' > ')}`);
    state.set(name, 'visiting');
    for (const parent of new Set(Object.values(tableInfo(name).refs))) {
      if (parent !== name) visit(parent, [...trail, name]);
    }
    state.set(name, 'done');
    out.push(name);
  };
  for (const t of TABLES) visit(t.name, []);
  return out;
}

/** Tables whose rows belong to one business (and so can be exported or imported for one). */
export const businessScoped = (t: TableInfo): boolean =>
  t.kind === 'tenant' || t.kind === 'tenant-lite';

/**
 * Settings that belong to this install, not to the business's data: tokens, credentials and PINs.
 * They never go into a backup or an export, so a file passed to an accountant cannot carry them.
 */
export const SECRET_SETTING =
  /^(secret|oauth|cloud\.(token|secret|credentials)|pin|device\.pin)\b/i;
export const isSecretSettingKey = (key: string): boolean => SECRET_SETTING.test(key);

/**
 * An audit row about a secret setting, with the value taken out. Rows written before the audit trail
 * stopped recording secrets may still hold one, and must not travel in a backup or an export.
 */
export function scrubAudit(row: Record<string, unknown>): Record<string, unknown> {
  if (row['table_name'] !== 'settings') return row;
  const secret = (side: unknown): boolean =>
    !!side &&
    typeof side === 'object' &&
    isSecretSettingKey(String((side as Record<string, unknown>)['key'] ?? ''));
  if (!secret(row['before_json']) && !secret(row['after_json'])) return row;
  const hide = (side: unknown) =>
    side && typeof side === 'object'
      ? { ...(side as Record<string, unknown>), value_json: '[removed]' }
      : side;
  return { ...row, before_json: hide(row['before_json']), after_json: hide(row['after_json']) };
}

/**
 * Rows from outside (a file someone sent, a backup of unknown origin) cleaned the way outgoing rows are:
 * no secret settings and no secret values in the audit trail. Without this a crafted file could plant a
 * cloud credential of its own and have every later backup uploaded to someone else's drive.
 */
export function sanitizeIncoming(
  table: string,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (table === 'settings') return rows.filter((r) => !isSecretSettingKey(String(r['key'] ?? '')));
  if (table === 'audit_log') return rows.map(scrubAudit);
  return rows;
}

/** A stored row as a plain object of portable values (numbers, strings, booleans, parsed JSON, null). */
export function toPortable(
  table: TableInfo,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(table.columns)) {
    if (!(k in row)) continue;
    let v = row[k];
    if (v === undefined) continue;
    if (v !== null) {
      switch (col.kind) {
        case 'json':
          if (typeof v === 'string') {
            try {
              v = JSON.parse(v);
            } catch {
              // a text value that is not JSON stays as it is
            }
          }
          break;
        case 'bool':
          v = v === true || v === 1 || v === '1' || v === 't' || v === 'true';
          break;
        case 'big':
        case 'int':
        case 'ts':
          if (typeof v === 'bigint') v = Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
          else if (typeof v === 'string' && /^-?\d+$/.test(v)) v = Number(v);
          break;
        default:
          break;
      }
    }
    out[k] = v;
  }
  return out;
}

/** Bytes of text, for sizes and hashes. */
const encoder = new TextEncoder();
export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Backups, restores and imports are for the local SQLite database (the browser and the desktop app).
 * A Postgres deployment is backed up with the database's own tools, and its row-level security would
 * hide other organisations' rows from a reader like this one.
 */
export function assertSqlite(d: { dialect: string }): void {
  if (d.dialect !== 'sqlite')
    throw new Error('Backup, restore and import work on the local SQLite database only.');
}

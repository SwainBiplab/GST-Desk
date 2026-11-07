/**
 * What syncs, which way, and which columns a client may change (prompt 41). One place, read by the
 * sync-rules generator, the server's write path and the client's upload connector, so the three can
 * never disagree about a table.
 */
import { isSecretSettingKey } from '../backup/tables';
import { tableColumns, type TableKind } from '../schema/dialect';
import { SPEC } from '../schema/spec';

export type SyncDirection = 'both' | 'down' | 'none';

export interface SyncTable {
  name: string;
  kind: TableKind;
  direction: SyncDirection;
  /** Columns the server sets and a client may not change (ignored on upload). */
  serverOwned: readonly string[];
  /** Rows the client may only add, never change (append-only evidence). */
  appendOnly?: boolean;
}

/**
 * Local only: identity and secrets (`users`, LAN `devices` with token hashes), per-device state
 * (`sync_state`), the AI call log and vectors (rebuilt per device), and the rate-master bookkeeping.
 * `organisations` is read from the server's own tables; `hsn_master` comes down in the shared bucket.
 */
const LOCAL_ONLY = new Set([
  'users',
  'organisations',
  'devices',
  'sync_state',
  'ai_calls',
  'hsn_embeddings',
  'rate_master_versions',
]);
const DOWN_ONLY = new Set(['hsn_master']);

const SERVER_OWNED: Record<string, readonly string[]> = {
  // the counter is the server's: devices take numbers from reserved ranges, never from the counter
  number_series: ['next_number', 'reserved_ranges_json'],
  // a range is made by the server; a device only reports how much of it it used
  number_reservations: ['series_id', 'device_id', 'from_number', 'to_number', 'status'],
};

export const SYNC_TABLES: SyncTable[] = SPEC.filter((s) => !LOCAL_ONLY.has(s.name)).map((s) => ({
  name: s.name,
  kind: s.kind,
  direction: DOWN_ONLY.has(s.name) ? 'down' : 'both',
  serverOwned: SERVER_OWNED[s.name] ?? [],
  ...(s.name === 'audit_log' ? { appendOnly: true } : {}),
}));

export const syncTable = (name: string): SyncTable | undefined =>
  SYNC_TABLES.find((t) => t.name === name);
export const UPLOAD_TABLES = SYNC_TABLES.filter((t) => t.direction === 'both').map((t) => t.name);

/** Every column of a synced table, in a stable order. */
export function syncColumns(name: string): string[] {
  const spec = SPEC.find((s) => s.name === name);
  if (!spec) throw new Error(`unknown table ${name}`);
  return Object.keys(tableColumns(spec));
}

/**
 * The money and identity of a document. Once a document is issued these change only through a revision
 * (`revision` goes up by one) and never on a cancelled one, so two devices cannot disagree about them.
 */
export const DOCUMENT_FINANCIAL = [
  'type',
  'number',
  'date',
  'party_id',
  'party_name',
  'place_of_supply_state',
  'supply_type',
  'reverse_charge',
  'currency',
  'fx_rate_micros',
  'total_taxable_paise',
  'total_cgst_paise',
  'total_sgst_paise',
  'total_igst_paise',
  'total_utgst_paise',
  'total_cess_paise',
  'tcs_paise',
  'tds_paise',
  'round_off_paise',
  'total_paise',
  'series_id',
] as const;

/** Lines of a document are financial through and through. */
export const LINE_FINANCIAL_TABLES = new Set(['document_lines']);

/** Settings that must never leave a device (cloud and GSP credentials, PINs). */
export const isUploadableSetting = (key: string): boolean => !isSecretSettingKey(key);

/** A short tag for a device, used in provisional numbers: the first eight hex digits of its id. */
export const deviceTag = (deviceId: string): string =>
  deviceId
    .replace(/[^0-9a-f]/gi, '')
    .slice(0, 8)
    .toUpperCase();

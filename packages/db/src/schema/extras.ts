/**
 * SQL that Drizzle cannot express: full-text search, delete guards and RLS.
 * Generated from SPEC so it stays aligned with the tables.
 */
import type { Dialect } from './dialect';
import { NO_DELETE_TABLES, TENANT_TABLES } from './spec';

export const BREAK = '--> statement-breakpoint';

/**
 * Tables added after migration 9000 was written. Migration 9000 is frozen as the first set of guards
 * (a Phase 0 database is taken forward by running the later migrations), so it must not mention a table
 * that does not exist yet. Each table here gets its guards in `9003_extras_gst` instead.
 */
export const TABLES_AFTER_V1 = ['gst_filings', 'gst_adjustments'] as const;
/** The GSTR-2B reconciliation tables: their guards are in `9004_extras_recon`. */
export const TABLES_RECON = [
  'gstr2b_imports',
  'gstr2b_entries',
  'gstr2b_decisions',
  'gst_issue_acks',
] as const;
/** The e-invoice and e-way bill tables: their guards are in `9005_extras_gsp`. */
export const TABLES_GSP = ['einvoices', 'ewaybills', 'gsp_jobs', 'gsp_log'] as const;
/** The TDS and TCS tables: their guards are in `9006_extras_tax`. */
export const TABLES_TAX = ['tax_challans', 'tax_deductions', 'tds_receivable'] as const;
/** The local AI tables (reference data, no org): their guard is in `9007_extras_ai`. */
export const TABLES_AI = ['hsn_embeddings'] as const;
/** The journal, recurring journal and year-end tables (prompt 50): their guards are in `9009_extras_ledger`. */
export const TABLES_LEDGER = ['recurring_journals', 'journal_vouchers', 'fiscal_years'] as const;
const later = (t: string) =>
  (TABLES_AFTER_V1 as readonly string[]).includes(t) ||
  (TABLES_LEDGER as readonly string[]).includes(t) ||
  (TABLES_AI as readonly string[]).includes(t) ||
  (TABLES_TAX as readonly string[]).includes(t) ||
  (TABLES_RECON as readonly string[]).includes(t) ||
  (TABLES_GSP as readonly string[]).includes(t);
const V1_NO_DELETE = NO_DELETE_TABLES.filter((t) => !later(t));
const V1_TENANT = TENANT_TABLES.filter((t) => !later(t));

/** Searchable text columns per table, as migration 9000 created them. Frozen: a changed list is a new migration. */
export const SEARCH_COLUMNS_V1: Record<string, string[]> = {
  parties: ['name', 'trade_name', 'gstin', 'phone', 'email', 'city'],
  items: ['name', 'sku', 'barcode', 'hsn'],
  documents: ['number', 'party_name', 'notes'],
  hsn_master: ['code', 'description'],
};

/** What search reads now: names also match their Roman-letter form (migration 9002). */
export const SEARCH_COLUMNS: Record<string, string[]> = {
  ...SEARCH_COLUMNS_V1,
  parties: ['name', 'name_latin', 'trade_name', 'gstin', 'phone', 'email', 'city'],
  items: ['name', 'name_latin', 'sku', 'barcode', 'hsn'],
};

/** Reference tables have no business_id. */
const GLOBAL_SEARCH = new Set(['hsn_master']);

/** Reference text is natural language: stem it. Names and numbers are not. */
const STEMMED = new Set(['hsn_master']);

function sqliteExtras(): string[] {
  const out: string[] = [];
  for (const [table, cols] of Object.entries(SEARCH_COLUMNS_V1)) {
    const fts = `${table}_fts`;
    const scoped = !GLOBAL_SEARCH.has(table);
    const lead = scoped ? ['id', 'business_id'] : ['id'];
    out.push(
      `CREATE VIRTUAL TABLE ${fts} USING fts5(${lead.map((c) => `${c} UNINDEXED`).join(', ')}, ${cols.join(', ')}, tokenize='${STEMMED.has(table) ? 'porter ' : ''}unicode61 remove_diacritics 2')`,
    );
    const colList = [...lead, ...cols].join(', ');
    const newVals = [
      ...lead.map((c) => `new.${c}`),
      ...cols.map((c) => `coalesce(new.${c}, '')`),
    ].join(', ');
    out.push(
      `CREATE TRIGGER ${table}_fts_ai AFTER INSERT ON ${table} WHEN new.deleted_at IS NULL BEGIN INSERT INTO ${fts}(${colList}) VALUES (${newVals}); END`,
    );
    out.push(
      `CREATE TRIGGER ${table}_fts_au AFTER UPDATE ON ${table} BEGIN DELETE FROM ${fts} WHERE id = old.id; INSERT INTO ${fts}(${colList}) SELECT ${newVals} WHERE new.deleted_at IS NULL; END`,
    );
  }
  for (const t of V1_NO_DELETE) {
    out.push(
      `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'hard delete forbidden on ${t}'); END`,
    );
  }
  out.push(
    `CREATE TRIGGER documents_soft_delete_draft_only BEFORE UPDATE OF deleted_at ON documents WHEN new.deleted_at IS NOT NULL AND old.status <> 'draft' BEGIN SELECT RAISE(ABORT, 'only draft documents can be soft-deleted'); END`,
    `CREATE TRIGGER audit_log_append_only BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
  );
  return out;
}

function pgExtras(): string[] {
  const out: string[] = [];
  for (const [table, cols] of Object.entries(SEARCH_COLUMNS_V1)) {
    // Separators become spaces so `QS-77` and `a@b.com` split into words like they do in SQLite.
    const expr = `translate(${cols.map((c) => `coalesce(${c}, '')`).join(` || ' ' || `)}, '-_/.@', '     ')`;
    out.push(
      `ALTER TABLE ${table} ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('${STEMMED.has(table) ? 'english' : 'simple'}', ${expr})) STORED`,
      `CREATE INDEX ${table}_search_idx ON ${table} USING gin (search)`,
    );
  }
  out.push(
    `CREATE FUNCTION forbid_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'hard delete forbidden on %', TG_TABLE_NAME; END $$`,
  );
  for (const t of V1_NO_DELETE) {
    out.push(
      `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete()`,
    );
  }
  out.push(
    `CREATE FUNCTION guard_document_soft_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND OLD.status <> 'draft' THEN RAISE EXCEPTION 'only draft documents can be soft-deleted'; END IF; RETURN NEW; END $$`,
    `CREATE TRIGGER documents_soft_delete_draft_only BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION guard_document_soft_delete()`,
    `CREATE FUNCTION forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$`,
    `CREATE TRIGGER audit_log_append_only BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_update()`,
  );
  for (const t of V1_TENANT) {
    const using = `org_id = current_setting('app.org_id')::uuid`;
    out.push(
      `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY tenant_isolation ON ${t} USING (${using}) WITH CHECK (${using})`,
    );
  }
  return out;
}

export function extrasSql(dialect: Dialect): string {
  const stmts = dialect === 'sqlite' ? sqliteExtras() : pgExtras();
  return stmts.map((s) => `${s};`).join(`\n${BREAK}\n`) + '\n';
}

/** Tables a row can be removed from for good once it is in the trash. Issued documents never are. */
export const PURGEABLE = ['parties', 'items', 'documents', 'document_lines'] as const;

/**
 * Lets the trash empty itself. Every table refuses `DELETE`; this relaxes that for a row that was
 * already moved to the trash (and for the lines of a trashed draft), on the tables in `PURGEABLE`. An
 * issued document cannot be moved to the trash (another trigger refuses), so it stays undeletable.
 */
export function purgeSql(dialect: Dialect): string {
  const stmts: string[] = [];
  if (dialect === 'sqlite') {
    for (const t of PURGEABLE) {
      const when =
        t === 'document_lines'
          ? `old.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = old.document_id AND d.deleted_at IS NOT NULL)`
          : `old.deleted_at IS NULL`;
      stmts.push(
        `DROP TRIGGER ${t}_no_delete`,
        `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'hard delete forbidden on ${t}'); END`,
      );
    }
  } else {
    stmts.push(
      `CREATE OR REPLACE FUNCTION forbid_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_TABLE_NAME IN ('parties', 'items', 'documents') AND (to_jsonb(OLD)->>'deleted_at') IS NOT NULL THEN RETURN OLD; END IF; IF TG_TABLE_NAME = 'document_lines' AND EXISTS (SELECT 1 FROM documents d WHERE d.id = OLD.document_id AND d.deleted_at IS NOT NULL) THEN RETURN OLD; END IF; RAISE EXCEPTION 'hard delete forbidden on %', TG_TABLE_NAME; END $$`,
    );
  }
  return stmts.map((s) => `${s};`).join(`\n${BREAK}\n`) + '\n';
}

/** Tables whose search columns changed in 9002. */
const REINDEXED = ['parties', 'items'] as const;

/**
 * Makes names searchable by their Roman-letter form: the search index of parties and items is rebuilt
 * with `name_latin` in it (SQLite: a new full-text table, triggers and a backfill; Postgres: the
 * generated `search` column is replaced). Nothing else about search changes.
 */
export function searchLatinSql(dialect: Dialect): string {
  const stmts: string[] = [];
  for (const table of REINDEXED) {
    const cols = SEARCH_COLUMNS[table]!;
    if (dialect === 'sqlite') {
      const fts = `${table}_fts`;
      const lead = ['id', 'business_id'];
      const colList = [...lead, ...cols].join(', ');
      const newVals = [
        ...lead.map((c) => `new.${c}`),
        ...cols.map((c) => `coalesce(new.${c}, '')`),
      ].join(', ');
      stmts.push(
        `DROP TRIGGER ${table}_fts_ai`,
        `DROP TRIGGER ${table}_fts_au`,
        `DROP TABLE ${fts}`,
        `CREATE VIRTUAL TABLE ${fts} USING fts5(${lead.map((c) => `${c} UNINDEXED`).join(', ')}, ${cols.join(', ')}, tokenize='unicode61 remove_diacritics 2')`,
        `CREATE TRIGGER ${table}_fts_ai AFTER INSERT ON ${table} WHEN new.deleted_at IS NULL BEGIN INSERT INTO ${fts}(${colList}) VALUES (${newVals}); END`,
        `CREATE TRIGGER ${table}_fts_au AFTER UPDATE ON ${table} BEGIN DELETE FROM ${fts} WHERE id = old.id; INSERT INTO ${fts}(${colList}) SELECT ${newVals} WHERE new.deleted_at IS NULL; END`,
        `INSERT INTO ${fts}(${colList}) SELECT ${[...lead, ...cols.map((c) => `coalesce(${c}, '')`)].join(', ')} FROM ${table} WHERE deleted_at IS NULL`,
      );
    } else {
      const expr = `translate(${cols.map((c) => `coalesce(${c}, '')`).join(` || ' ' || `)}, '-_/.@', '     ')`;
      stmts.push(
        `DROP INDEX ${table}_search_idx`,
        `ALTER TABLE ${table} DROP COLUMN search`,
        `ALTER TABLE ${table} ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('simple', ${expr})) STORED`,
        `CREATE INDEX ${table}_search_idx ON ${table} USING gin (search)`,
      );
    }
  }
  return stmts.map((s) => `${s};`).join(`\n${BREAK}\n`) + '\n';
}

/**
 * Guards for the GST return tables (added after migration 9000): no hard delete, and on Postgres the
 * same tenant isolation every business table has.
 */
function guardsSql(dialect: Dialect, tables: readonly string[]): string {
  const stmts: string[] = [];
  for (const t of tables) {
    if (dialect === 'sqlite') {
      stmts.push(
        `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'hard delete forbidden on ${t}'); END`,
      );
    } else {
      const using = `org_id = current_setting('app.org_id')::uuid`;
      stmts.push(
        `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete()`,
        `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
        `CREATE POLICY tenant_isolation ON ${t} USING (${using}) WITH CHECK (${using})`,
      );
    }
  }
  return stmts.map((s) => `${s};`).join(`\n${BREAK}\n`) + '\n';
}

/**
 * Guards for the GST return tables (added after migration 9000): no hard delete, and on Postgres the
 * same tenant isolation every business table has.
 */
export const gstExtrasSql = (dialect: Dialect): string => guardsSql(dialect, TABLES_AFTER_V1);

/** The same guards for the GSTR-2B reconciliation tables. */
export const reconExtrasSql = (dialect: Dialect): string => guardsSql(dialect, TABLES_RECON);

/** The same guards for the e-invoice and e-way bill tables. */
export const gspExtrasSql = (dialect: Dialect): string => guardsSql(dialect, TABLES_GSP);

/** The AI reference tables have no org, so they get the delete guard and no row-level security. */
export const aiExtrasSql = (dialect: Dialect): string =>
  TABLES_AI.map((t) =>
    dialect === 'sqlite'
      ? `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'hard delete forbidden on ${t}'); END;`
      : `CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();`,
  ).join(`\n${BREAK}\n`) + '\n';

/** The same guards for the TDS and TCS tables. */
export const taxExtrasSql = (dialect: Dialect): string => guardsSql(dialect, TABLES_TAX);
export const ledgerExtrasSql = (dialect: Dialect): string => guardsSql(dialect, TABLES_LEDGER);

/**
 * SQLite drops a table's triggers when a migration rebuilds it (0011 rebuilt `number_reservations` to drop a
 * foreign key). Put the delete guard back where it may be missing; a fresh database already has it from 9000.
 */
export const restoreGuardsSql = (dialect: Dialect): string =>
  dialect === 'sqlite'
    ? `CREATE TRIGGER IF NOT EXISTS number_reservations_no_delete BEFORE DELETE ON number_reservations BEGIN SELECT RAISE(ABORT, 'hard delete forbidden on number_reservations'); END;\n`
    : 'SELECT 1;\n';

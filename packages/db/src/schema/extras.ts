/**
 * SQL that Drizzle cannot express: full-text search, delete guards and RLS.
 * Generated from SPEC so it stays aligned with the tables.
 */
import type { Dialect } from './dialect';
import { NO_DELETE_TABLES, TENANT_TABLES } from './spec';

export const BREAK = '--> statement-breakpoint';

/** Searchable text columns per table. */
export const SEARCH_COLUMNS: Record<string, string[]> = {
  parties: ['name', 'trade_name', 'gstin', 'phone', 'email', 'city'],
  items: ['name', 'sku', 'barcode', 'hsn'],
  documents: ['number', 'party_name', 'notes'],
  hsn_master: ['code', 'description'],
};

/** Reference tables have no business_id. */
const GLOBAL_SEARCH = new Set(['hsn_master']);

/** Reference text is natural language: stem it. Names and numbers are not. */
const STEMMED = new Set(['hsn_master']);

function sqliteExtras(): string[] {
  const out: string[] = [];
  for (const [table, cols] of Object.entries(SEARCH_COLUMNS)) {
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
  for (const t of NO_DELETE_TABLES) {
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
  for (const [table, cols] of Object.entries(SEARCH_COLUMNS)) {
    const expr = cols.map((c) => `coalesce(${c}, '')`).join(` || ' ' || `);
    out.push(
      `ALTER TABLE ${table} ADD COLUMN search tsvector GENERATED ALWAYS AS (to_tsvector('${STEMMED.has(table) ? 'english' : 'simple'}', ${expr})) STORED`,
      `CREATE INDEX ${table}_search_idx ON ${table} USING gin (search)`,
    );
  }
  out.push(
    `CREATE FUNCTION forbid_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'hard delete forbidden on %', TG_TABLE_NAME; END $$`,
  );
  for (const t of NO_DELETE_TABLES) {
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
  for (const t of TENANT_TABLES) {
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

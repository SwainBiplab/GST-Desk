# 0002 — One schema spec, two SQL dialects

Status: accepted. Context: prompt 04, PRD 12.1 and 12.3.

## Decision

- Tables are described once, as data, in `packages/db/src/schema/spec.ts` using a small column DSL
  (`dialect.ts`). `build(dialect, SPEC)` compiles that into Drizzle `sqlite-core` or `pg-core` tables.
  `schema/sqlite.ts` and `schema/pg.ts` are the Drizzle Kit entrypoints (a test checks they list every table).
- Common columns: `id` (uuid text), `org_id`, `business_id`, `version`, `created_at`, `updated_at`,
  `deleted_at`, `created_by`, `updated_by`. The operating prompt (01) was empty, so this set is our choice.
  `audit_log` is append-only and carries only `id`, `org_id`, `business_id`, `created_at`.
- Type mapping: money/quantity = integer (`bigint` as JS number on Postgres); timestamps = epoch ms;
  dates = `YYYY-MM-DD`; JSON = `text` (mode json) on SQLite and `jsonb` on Postgres; booleans native.
- Things Drizzle cannot express live in generated "extras" migrations (`schema/extras.ts`):
  FTS5 tables + sync triggers (SQLite), generated `tsvector` columns + GIN (Postgres), triggers that forbid
  hard deletes and non-draft soft deletes, and Postgres RLS (`org_id = current_setting('app.org_id')::uuid`).
- Migrations are Drizzle Kit SQL per dialect, embedded into `migrations.generated.ts` so Tauri and the PWA
  need no filesystem. `migrate()` applies each in its own transaction, forward-only, recording
  `schema_meta` (`migration:<name>` and `version`). `schema_meta` is created by `migrate()` itself.
- Repositories are dialect-agnostic: they use Drizzle's query builder plus a few raw statements for FTS.
  Every call goes through `runInTx`, which on Postgres sets `app.org_id` for the transaction.

## Consequences

- Row types are loose (`Record<string, any>`), not inferred from the spec. A typed layer can be generated later.
- Until the first release the v1 migration may be regenerated; afterwards every schema change needs a new
  numbered migration plus a new extras file (the extras list is regenerated from SPEC today).
- Postgres tests run on PGlite (real Postgres in WASM) under a non-superuser role so RLS is enforced.
  Docker is not required; Testcontainers can replace it for CI parity.
- `DocumentRepo` validates money through an injected `LineValidator`. The built-in `arithmeticValidator`
  stands in until `@gst/domain` (prompt 05) provides the tax engine.

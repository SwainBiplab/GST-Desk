# @gst/db

Drizzle schema (SQLite + Postgres), migrations, repositories, seed and test harness. See ADR 0002.

- `pnpm --filter @gst/db db:generate` – regenerate Drizzle Kit SQL for both dialects and the embedded `migrations.generated.ts`.
- `pnpm --filter @gst/db db:seed [file]` – write a deterministic demo SQLite file (default `demo.sqlite`, gitignored).
- `pnpm --filter @gst/db test` – every repository test runs on SQLite (in-memory) and Postgres (PGlite).

Usage: `const d = await openSqlite('file:app.db'); await migrate(d);` then `new PartyRepo(d).create(ctx, {...})` with
`ctx = { orgId, businessId, actor, deviceId }`. Use `runInTx(d, ctx, tx => repo.x({ ...ctx, tx }))` to compose calls.

Items and the HSN master (prompt 13): `ItemRepo` (validation through `@gst/domain`, unique SKU and barcode, `gst_rate_overridden`, opening stock, `bulkCreate`, `applyBulkEdit` / `undoBulkEdit`, `rateChanges`), `UnitRepo`, `ImportMappingRepo`, and the reference-data functions in `hsn-master.ts` (`importHsnVersion` keeps rate history, `lookupHsn`, `HsnResolver`, `listHsnVersions`). Reference data is imported with `importHsnVersion(d, { version, as_of }, rows)`; see `docs/runbooks/hsn-master.md`.

Numbering, cancellation and audit (prompt 15): `NumberingRepo` (series per type with a counter per financial year, defaults per type and shell, preview, device ranges `reserveRange` / `releaseRange`, `getMode` / `setMode`), `PeriodLockRepo` (`get`, `set`, `assertOpen` with an owner override that is audited), and on `DocumentFlowRepo`: `cancelDocument`, `editIssuedNotes`, `reviseIssued` (a numbered revision, ledger and stock reposted), `finaliseNumber` and `findByNumber`. `ctx.role` is optional; absent means the local owner. `AuditRepo.search` and `documentHistory` read the trail. Issue, cancel and revise run through one queue per database. See `docs/decisions/0006-numbering-cancellation-and-audit.md`.

# 0003 — Browser database and app shell

Status: accepted. Context: prompt 10, PRD 12.1.

## Decision

- **One repository layer, three engines.** `@gst/db` repositories run unchanged on Node (libsql, PGlite for tests), in the browser and on desktop. Only the opener differs. Node-only openers moved to `@gst/db/node` so the browser bundle never sees libsql or PGlite.
- **Browser SQLite = the official `@sqlite.org/sqlite-wasm` in a dedicated worker, stored in OPFS through the `opfs-sahpool` VFS.** It needs no cross-origin isolation headers (unlike the `opfs` VFS). If OPFS is unavailable or another tab holds the lock, the worker falls back to an in-memory database and the UI shows "Local (not saved)". The PRD names wa-sqlite; the official build was chosen because it ships FTS5, a maintained OPFS VFS and TypeScript types, and exposes the same SQLite API.
- **Drizzle `sqlite-proxy`** connects the worker to the repositories. Rows cross the worker boundary as arrays plus column names; `queryRows` turns them back into objects. Transactions are `BEGIN`/`COMMIT` on the single connection, serialised by a mutex so two `runInTx` calls never interleave.
- **Desktop** uses the Tauri SQL plugin through the same proxy. **Not verified**: the plugin pools connections, so transactions may not share one. Prompt 23 replaces it with a single-connection Rust command before the desktop app ships.
- **Live queries.** Repositories record the tables they write (`noteWrite`); `runInTx` announces them after commit (`onChange`). `useLiveQuery({ tables, key, fn })` tags its TanStack Query with the tables it reads and refetches when any of them changes. Query keys are `[...tables, businessId, ...key]`.
- **Lazy database.** The shell paints first; `db-impl.ts` (sqlite, drizzle, migrations) is a dynamic import. Pages show data when it arrives.
- **Routing.** Two layouts (`/shop`, `/books`) and one `$page` route per shell; unknown pages 404 inside the shell. `/` redirects to the shell used last on this device. Shell switching keeps the page.
- **Command bar** = cmdk with our own ranking (`actions.ts`), a small typed-argument grammar (`grammar.ts`), FTS search through the repositories, and an assistant stub that calls `AiRouter.suggest`.
- **Updates.** The service worker uses `registerType: 'prompt'`; an update bar offers a reload and the app never reloads itself.

## Consequences

- The wasm file (about 880 KB, 410 KB gzipped) is precached for offline use. It is not counted in the JS/CSS bundle budgets.
- The e2e suite runs against `vite preview` and exercises the real worker, OPFS and the service worker; a stale dev server on port 1420 would silently be reused, so stop it before running e2e.
- `/books/_crash` is a deliberate diagnostics route that throws on render, used by the e2e suite for the error boundary.

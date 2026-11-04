# How to run GST Desk

Everything below runs from the repository root, `d:\GST\gst-desk`, unless it says otherwise.

## 1. What you need

| Tool                                                      | Version                | Needed for                                                         |
| --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| Node.js                                                   | 22 or newer (24 works) | everything                                                         |
| pnpm                                                      | 10                     | everything (`npm i -g pnpm`)                                       |
| Chrome or Edge                                            | recent                 | the web app (it stores data in the browser's private file storage) |
| Rust (via rustup)                                         | stable                 | the desktop app only                                               |
| Visual Studio Build Tools, "Desktop development with C++" | 2019 or newer          | the desktop app only (Windows)                                     |
| WebView2                                                  | built into Windows 11  | the desktop app only                                               |
| Docker                                                    | optional               | not needed to run or test; PGlite is used for Postgres tests       |

Check:

```powershell
node -v
pnpm -v
```

## 2. First time

```powershell
pnpm install
```

That installs every package in the monorepo. Run it again after pulling changes that touch a `package.json`.

## 3. Run the web app

```powershell
pnpm dev
```

Open **http://localhost:1420**. The port is fixed; if something else uses it the server stops with an error instead of picking another port.

First run: the app sends you to the setup wizard (`/welcome`). To look around quickly:

- Click **Try it with a sample business** in the wizard, or
- open `http://localhost:1420/books/dashboard?demo=1` on an empty browser profile. That loads the demo business (50 parties, 200 items, 500 documents).
- Add `&heavy=1` for one extra party with 200 invoices, to see Party 360 at scale.

Where things are:

| Address            | What                                                     |
| ------------------ | -------------------------------------------------------- |
| `/shop/dashboard`  | Shop mode (big buttons, counter use)                     |
| `/books/dashboard` | Books mode (dense screens, keyboard shortcuts)           |
| `/books/parties`   | Parties list; open one for Party 360                     |
| `/books/settings`  | Business profile, logo and stamp, features, businesses   |
| `/books/_kit`      | The UI component kit                                     |
| `/welcome`         | Setup wizard (`/welcome?add=true` adds another business) |

Keys: `Ctrl+K` or `/` opens the command bar; `?` shows the keyboard map; in Books, `G` then `P` goes to Parties. Full list: `docs/keyboard.md`.

Your data lives in the browser (origin `localhost:1420`) in a private file store. To start again, clear site data for `localhost:1420` in the browser settings, or use a private window (which falls back to memory, and the status pill says "Local (not saved)").

### Test the installed-app behaviour (offline, update bar)

The dev server does not register the service worker. To test it, run the production build:

```powershell
pnpm --filter web build
pnpm --filter web exec vite preview --port 1420 --strictPort
```

Load the page once, then once more; after that it works with the network off.

## 4. Run the desktop app

One-time setup on Windows:

1. Install Rust from https://rustup.rs.
2. Install Visual Studio Build Tools with the **Desktop development with C++** workload.
3. **Open a new terminal** so `cargo` is on your PATH. If `cargo` is still not found, add it for this window:

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo --version
```

Then:

```powershell
pnpm --filter desktop tauri dev
```

The first run compiles about 500 Rust crates and takes several minutes; later runs take seconds. A "GST Desk" window opens showing the same app. Its data is stored separately from the browser's.

Notes:

- Tauri starts the web dev server itself on port 1420, so **stop `pnpm dev` first**.
- The desktop database uses the Tauri SQL plugin. It works for the first-run flow and the demo data, but transaction handling is not yet verified for release; see ADR 0003.
- Building installers (`tauri build`) also needs a real updater key and platform signing; see `docs/runbooks/signing.md`.

## 5. Storybook (UI components)

```powershell
pnpm --filter @gst/ui storybook
```

Opens at **http://localhost:6006**. Use the toolbar to switch light/dark and compact/comfortable.

## 6. Checks and tests

| Command                    | What it does                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm lint`                | ESLint across every package                                                                        |
| `pnpm typecheck`           | TypeScript                                                                                         |
| `pnpm test`                | unit and integration tests (Vitest)                                                                |
| `pnpm test:coverage`       | the same with coverage                                                                             |
| `pnpm e2e`                 | Playwright end-to-end tests against the production build                                           |
| `pnpm perf`                | performance budgets (web load times, database list and search)                                     |
| `pnpm ci:local`            | everything CI does: lint, typecheck, audit, tests with coverage, e2e, Storybook build, bundle size |
| `pnpm ci:local static e2e` | only the named stages (`static`, `test`, `e2e`, `bundle`)                                          |

First e2e run needs a browser: `pnpm --filter web exec playwright install chromium`.

Before running e2e, **stop any dev server on port 1420**. Playwright reuses whatever is listening there, and the dev server has no service worker, so the offline test would fail.

Run one package: `pnpm --filter @gst/db test`, `pnpm --filter @gst/domain test`, `pnpm --filter web test`.

## 7. Database tasks

```powershell
pnpm --filter @gst/db db:seed demo.sqlite     # write a deterministic demo SQLite file
pnpm --filter @gst/db db:generate             # regenerate migrations after changing the schema
```

The schema is defined once in `packages/db/src/schema/spec.ts` and compiled for SQLite and Postgres. After changing it, run `db:generate` and commit the generated files. Details: `docs/decisions/0002-dual-dialect-schema.md`.

## 8. AI evaluation (offline)

```powershell
pnpm ai:eval --provider mock
pnpm ai:eval --provider rules --schema hsnSuggestion
```

Prints field-level accuracy over the fixtures in `packages/ai/fixtures`.

## 9. Releases

CI builds installers and drafts a release; a person publishes it. See `docs/runbooks/release.md`. To verify a build locally:

```powershell
pnpm release:verify --bundle-dir <folder> [--manifest latest.json --pubkey-file <file>] [--previous-db <file>]
```

## 10. Layout of the repository

```
apps/web         the app (React, Vite, PWA); also what the desktop window shows
apps/desktop     Tauri shell (Rust) around apps/web
packages/domain  tax engine, numbering, ledger posting, party accounts (pure TypeScript)
packages/db      schema, migrations, repositories, seed (SQLite and Postgres)
packages/ui      design tokens and components, Storybook
packages/ai      AI provider interface, rules backend, redaction, evals
packages/config  shared TypeScript and ESLint settings
scripts          release tools and their tests
docs             decisions (ADRs), runbooks, compliance checklist, keyboard map
```

## 11. Troubleshooting

| Symptom                                              | Fix                                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Port 1420 is already in use`                        | Stop the other dev server (or the desktop app); check with `netstat -ano \| findstr :1420`.                                              |
| `cargo metadata ... program not found`               | Rust is not on PATH in this terminal; see section 4.                                                                                     |
| Blank page after an update                           | Hard-reload; if you ran the production build, unregister the service worker in browser dev tools.                                        |
| "Local (not saved)" in the top bar                   | The browser could not open its private file storage (private window, or another tab has the database open). Close other tabs of the app. |
| Data looks wrong after pulling new code              | The schema can change before release. Clear site data for `localhost:1420` and reload with `?demo=1`.                                    |
| e2e fails with `ECONNREFUSED` or offline test fails  | A dev server is running on 1420; stop it.                                                                                                |
| `pnpm install` complains about an unsupported engine | Use Node 22 or newer.                                                                                                                    |

# GST Desk

Monorepo: `apps/web` (PWA), `apps/desktop` (Tauri v2), `packages/*`.

## Setup

1. Node >= 22 and pnpm 10 (`npm i -g pnpm`).
2. `pnpm install`
3. `pnpm dev` (web on http://localhost:1420), `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e`.

## Desktop (Tauri) prerequisites

- Install Rust via https://rustup.rs
- **Linux:** `libwebkit2gtk-4.1-dev build-essential libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- **macOS:** Xcode Command Line Tools
- **Windows:** Visual Studio Build Tools (C++ workload) and WebView2
- Run: `pnpm --filter desktop tauri dev`

## Quality gates and releases

- `pnpm ci:local` runs the same stages as `.github/workflows/ci.yml`: lint and typecheck, audit, tests with coverage, Playwright e2e, Storybook build and bundle size (`pnpm ci:local static e2e` runs only some stages).
- `pnpm perf` runs the budgets in `apps/web/perf` and `packages/db/perf` (set `PERF_DOCS=50000` for the full-size database check).
- Releases are drafted by CI and published by a person: see `docs/runbooks/release.md` and `docs/runbooks/signing.md`.
- `pnpm release:verify --bundle-dir <dir> [--manifest latest.json --pubkey-file <file>] [--previous-db <file>]` checks size, headers, migrations and updater signatures.

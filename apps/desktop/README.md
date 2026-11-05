# desktop

The Tauri v2 shell around `apps/web`: installers, the database, updates and OS integration. Read `docs/decisions/0014-desktop-shell.md` first. Requires the Rust toolchain.

## What is here

| Path                            | What it does                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src-tauri/src/db.rs`           | One SQLite connection (and a second for a restore) behind `db_open`, `db_exec`, `db_close`.            |
| `src-tauri/src/paths.rs`        | The data folder, the move wizard, removing old restore folders.                                        |
| `src-tauri/src/update.rs`       | Check, background download, install and restart; stable and beta channels; keeps the previous version. |
| `src-tauri/src/tray.rs`         | The tray icon and its quick actions.                                                                   |
| `src-tauri/src/launch.rs`       | `.gstbk` files and `gstdesk://` links handed to the app.                                               |
| `src-tauri/src/diag.rs`         | "Report a problem": a ZIP of scrubbed logs, never data.                                                |
| `src-tauri/src/printers.rs`     | Printer names for the thermal settings.                                                                |
| `src-tauri/tauri.conf.json`     | Identifier, bundles, per-user NSIS, file association, deep link, updater, CSP.                         |
| `src-tauri/installer-hooks.nsh` | The uninstall message: your data was left where it is.                                                 |
| `app-icon.svg`                  | The one source of every icon: `pnpm --filter desktop icons` regenerates them.                          |
| `e2e/`                          | The WebDriver smoke test and the script that makes its throw-away key and fixtures.                    |

## Commands

```
pnpm --filter desktop tauri dev              # run with the web dev server
pnpm --filter desktop test                   # Rust unit tests
pnpm --filter desktop tauri build            # installers for this system (needs the signing key unless createUpdaterArtifacts is off)
pnpm --filter desktop icons                  # regenerate icons from app-icon.svg
```

A local installer without the signing key: `pnpm --filter desktop tauri build --bundles nsis --config '{"bundle":{"createUpdaterArtifacts":false}}'`. Testing, including the smoke test: `docs/runbooks/desktop-testing.md`. Releasing: `docs/runbooks/release.md` and `signing.md`.

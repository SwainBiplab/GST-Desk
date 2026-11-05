# Beta checklist: v0.1.0-beta.1

Run before a beta build is handed to anyone. **Each line says what was actually done; a line that was not done says so.** Nothing is published by this checklist. The release itself stays a draft until a human publishes it (`docs/runbooks/release.md`).

Status key: **done** (with evidence), **not done** (and who or what is needed), **n/a**.

## Quality gates

| Check                                                            | Status                   | Evidence or what is missing                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lint and typecheck across the repository                         | done                     | `pnpm lint` and `pnpm typecheck` green.                                                                                                                                                                                                    |
| Unit tests                                                       | done                     | domain 502, db 475, ai 89, i18n 254, web 203, print 102, ui 44, drills 10, scripts 38, Rust 21; all passing (print's PDF tests need a quiet machine: run alone they pass in 15 s).                                                         |
| End-to-end suite (browser)                                       | done                     | The full Playwright suite on the built app: 208 of 208, including `a11y`, `help`, `i18n`, `inbox`.                                                                                                                                         |
| Coverage: domain above 95%, db above 85%, web features above 70% | done                     | domain 97.2% statements, db 90.8%, web features 73.8% statements (driven by the end-to-end suite, `pnpm --filter web e2e:coverage`; unit tests alone cover 13.9% of the feature files because screens are exercised by the browser suite). |
| Data-safety drills                                               | done                     | `tests/drills`: damage and restore (3 kinds of damage, plus a corrupted backup refused), power loss while issuing (4 kill points, run repeatedly), Phase 0 database migrated to the current schema. Nightly in `drills.yml`.               |
| Accessibility (axe) on every route, both shells, both themes     | done                     | 4 of 4 passing, no serious or critical violations (`docs/qa/a11y.md`).                                                                                                                                                                     |
| Keyboard-only walkthrough and screen reader pass by a person     | **not done**             | Needs someone who uses a screen reader; B-091.                                                                                                                                                                                             |
| Security review                                                  | done                     | `docs/security/review-p1.md`: no open Must findings.                                                                                                                                                                                       |
| `pnpm audit --prod` and `cargo audit`                            | done                     | No high or critical. One moderate (build-time) and five unmaintained-crate warnings, accepted.                                                                                                                                             |
| Performance budgets measured                                     | done, with one exception | `docs/perf/p1-results.md`; the keystroke exception is ADR 0015.                                                                                                                                                                            |
| i18n checks                                                      | done                     | `pnpm i18n:check` and `i18n:extract` pass. Hindi 100%; Marathi, Tamil, Bengali, Gujarati about 6% (documented, drafts in `locales-todo`).                                                                                                  |
| Storybook builds                                                 | done                     | `pnpm --filter @gst/ui build-storybook` builds (with the locale toolbar and pseudo-locale).                                                                                                                                                |

## Usability

| Check                                                 | Status       | Evidence or what is missing                                                                     |
| ----------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| Five first-invoice runs, median under 10 minutes (G8) | **not done** | No participants yet. Script and recording sheet: `docs/ux/beta-usability.md`. G8 is unverified. |
| Top three friction points fixed                       | **not done** | Depends on the runs above.                                                                      |

## Builds

| Check                                                | Status       | Evidence or what is missing                                                                                                                     |
| ---------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop.yml` artifacts for Windows, macOS and Linux | **not done** | The workflow cannot be run from here. A Windows NSIS installer was built locally: 8.06 MiB (limit 15 MB). The other installers are built by CI. |
| `verify-release.mjs` passes on the CI artifacts      | **not done** | Runs in CI on the built bundles; its unit tests pass (including a tampered manifest being refused).                                             |
| Desktop smoke test (WebDriver) on Windows            | **not done** | Written and in `desktop.yml`; not run (needs the Edge WebDriver). B-083.                                                                        |
| Install, update and uninstall on 4 systems           | **not done** | `docs/qa/install-matrix.md` is all "not run". B-082.                                                                                            |
| Updater public key and address set                   | **not done** | Empty on purpose until the release owner creates the key. B-084.                                                                                |
| Installers signed and notarised                      | **not done** | Certificates do not exist yet. B-085.                                                                                                           |

## Data

| Check                                                   | Status | Evidence                                                                                                                                 |
| ------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Migration from the previous schemas, backup taken first | done   | The migration drill (from the Phase 0 schema) and the migrate tests; the app takes a backup before migrating a database that holds data. |
| Restore of a backup made by the previous version        | done   | Backups restore into an older-schema database by migrating first (backup tests); the drill restores over a damaged file.                 |

## Content and support

| Check                                                     | Status        | Evidence or what is missing                                                                                                              |
| --------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| In-app help for every screen, searchable, contextual      | done          | F1 and Help in the top bar; `help` namespace; tests in `e2e/help.spec.ts`.                                                               |
| Getting started guide in six languages                    | done (drafts) | Hindi, Marathi, Tamil, Bengali, Gujarati and English; the five non-English are drafts flagged for native review (`docs/i18n/review.md`). |
| Privacy page; usage counters off by default and opt-in    | done          | `docs/privacy.md`, Settings, Privacy; tests assert nothing is stored while it is off.                                                    |
| Native-speaker and CA review of translations and glossary | **not done**  | `docs/i18n/review.md` lists each language as pending.                                                                                    |
| CA sign-off of the starter HSN master                     | **not done**  | B-001; the starter data is unreviewed and the app says so. Blocks general availability, not the beta.                                    |
| Diagnostics bundle verified                               | done          | Unit tests: scrubbed logs only, never the database.                                                                                      |
| Rollback plan                                             | done          | `docs/runbooks/release.md`, "Roll back"; the desktop app keeps the previous version before installing.                                   |

## Known issues in the beta

- Only Hindi is fully translated; the other four languages show most screens in English.
- No installer is signed, so Windows SmartScreen and macOS Gatekeeper will warn.
- The update check does nothing until the release owner adds the public key and address.
- Amount in words prints in English for Tamil, Bengali and Gujarati.
- Typing a character in a very long invoice (200 lines) is occasionally shown one frame late (ADR 0015).
- The starter HSN master has 112 codes and has not been reviewed by a chartered accountant.
- Windows MSI installs for all users and needs administrator rights; use the per-user installer.
- Backups and restores cover the SQLite database only; Postgres deployments use their own tools.

The full open list is `docs/backlog.md`.

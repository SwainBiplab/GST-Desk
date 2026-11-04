# Release runbook

Releases are drafted by CI and published by a person. Nothing goes out automatically.

## Before the first release (once)

1. Create the updater signing key and store it as described in [signing.md](./signing.md).
2. Put the **public** key in `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) and in the repository variable `TAURI_UPDATER_PUBKEY`.
3. Set `plugins.updater.endpoints` to `["https://<update-host>/latest.json"]` and the repository variable `UPDATE_BASE_URL` to the folder that will hold the installers (default: the GitHub release download URL).
4. Commit `Cargo.lock` (generate it with `cargo generate-lockfile` in `apps/desktop/src-tauri`); CI caches and reproduces builds from it.
5. Fill the platform signing secrets listed in `signing.md`. Unsigned builds work for testing but must never be released.

## Cutting a release

1. Every user-visible change lands with a changeset (`pnpm changeset`).
2. After merging to `main`, the `release` workflow opens or updates a **"chore: version packages"** PR. It bumps `apps/desktop/package.json`, then `pnpm release:sync-version` copies the version into `tauri.conf.json` and `Cargo.toml`.
3. If the release touches tax logic, return formats or rate data, get the CA reviewer's sign-off first (CR-08): walk through `docs/compliance/tax-engine-review.md` and record the result in the PR.
4. Merge the version PR. The workflow tags `v<version>`, runs `desktop.yml` on Linux, Windows and macOS, writes `latest.json`, runs `scripts/verify-release.mjs`, and creates a **draft** GitHub release with all installers, signatures and `latest.json`.
5. Review the draft:
   - the verify step passed: every installer under 15 MB, headers valid, every updater signature verifies;
   - install the bundle for your platform on a clean machine and open the app;
   - upgrade from the previous release and confirm data survives. Locally:
     ```
     git checkout v<previous> && pnpm --filter @gst/db db:seed previous.sqlite && git checkout -
     pnpm release:verify --bundle-dir <bundles> --previous-db previous.sqlite
     ```
6. Publish the draft. Then upload `latest.json` and the installers to `UPDATE_BASE_URL` if it is not the release page itself. Clients pick the update up on their next check.

## Roll back

The updater only offers the version named in `latest.json`.

1. Edit `latest.json` at the update host so `version` and every `platforms.*.url` point at the **previous** good release, signatures included (keep a copy of each release's `latest.json`).
2. Un-publish or mark the bad GitHub release as pre-release so nobody downloads it by hand.
3. Clients already on the bad version will see no update, because their version is newer. Ship a **hotfix** with a higher version number; never reuse a version number.
4. Databases are migrated forward only. If the bad release changed the schema, the hotfix must include a forward migration that repairs it. Restore from the pre-migration backup (prompt 20) only for confirmed data loss.

## Hotfix

1. Branch from the release tag: `git switch -c hotfix/<version> v<version>`.
2. Make the smallest fix, add a test that fails without it and a changeset (patch).
3. Open a PR to `main` (CI must pass), merge, and let the version PR flow produce `v<version+patch>`. If `main` has unreleased work you cannot ship, cherry-pick the fix onto a `release/<minor>` branch, run `pnpm changeset version`, tag it and run `desktop.yml` manually from that branch.
4. Follow the same review and publish steps. Update `latest.json` last.

## If a step fails

- **verify-release fails on size:** the AppImage or installer grew past the 15 MB budget (NFR-09). Find the new dependency or asset with `pnpm --filter web build` and a bundle analyser; do not raise the limit without a recorded decision.
- **verify-release fails on a signature:** the file was modified after signing, or the wrong key signed it. Rebuild; never re-sign by hand.
- **Migration check fails:** do not release. Fix the migration and add the previous release's seeded database to the test.

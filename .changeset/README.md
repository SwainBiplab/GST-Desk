# Changesets

Run `pnpm changeset` to describe a change. The release workflow turns pending changesets into a version PR.
The app version lives in `apps/desktop/package.json`; `pnpm release:sync-version` copies it into `tauri.conf.json` and `Cargo.toml`.

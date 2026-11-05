# Testing the desktop app

## Quick: the Rust unit tests

```
pnpm --filter desktop test
```

They cover the database bridge (transactions across calls, foreign keys, FTS5, big integers, blobs), the data-folder rules and the move wizard, the diagnostics ZIP (scrubbing, nothing but logs), printer parsing, launch requests, the tray menu and the update channel.

## The smoke test (a real app, real Rust database, real updater)

It drives the built app through `tauri-driver` (WebDriver) on Windows, using the Edge WebDriver that matches the installed WebView2.

1. Install the drivers once: `cargo install tauri-driver --locked`, and download `msedgedriver` for your WebView2 version from `https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip` (the version is in `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`, value `pv`).
2. Make a throw-away update key, a signed "release", a tampered copy of it, and a test config: `node apps/desktop/e2e/make-fixtures.mjs` (writes `apps/desktop/e2e/.generated`, ignored by git; the key signs only these files).
3. Build a debug app that trusts the test key: `pnpm --filter desktop tauri build --debug --no-bundle --config e2e/.generated/test-config.json`.
4. Run it:
   ```
   node apps/desktop/e2e/smoke.mjs --app apps/desktop/src-tauri/target/debug/gst-desk.exe \
     --native <path to msedgedriver.exe> --fixtures apps/desktop/e2e/.generated/fixtures
   ```

The app runs with `GSTDESK_DATA_DIR` set to a scratch folder, so a real person's data is never touched. CI runs the same thing in the `smoke` job of `desktop.yml`.

What it checks: launch; the demo business (500 documents) loads through the Rust connection and the database file is in the data folder; the Desktop tab shows that folder and the printer list renders; an update check against a local mock server finds the newer version; a download with a valid signature is accepted and a tampered one is refused; the beta channel reads `beta/latest.json`.

What it does not check: the system print dialog (it cannot be driven from WebDriver; printing is covered by the browser end-to-end suite and by checking the dialog by hand in `docs/qa/install-matrix.md`), the tray, notifications, launch at login, file association and `gstdesk://` links (those need the installed app and a desktop session; they are on the manual checklist in the install matrix).

## Measuring start-up and memory

Build a release app (`pnpm --filter desktop tauri build --bundles nsis`), install it, load the demo business, close and reopen it. Cold start to interactive is the time from launching to the dashboard showing numbers; memory is the sum of the app and its WebView2 processes in Task Manager (target: under 2 s and under 250 MB on the baseline laptop). Record the figures in the install matrix.

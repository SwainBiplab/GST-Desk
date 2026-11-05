# Install matrix

Install, run, update to a mock next version, and uninstall, on each supported system. **Nothing in this table has been signed off yet**: only what is marked as done was actually run, and the rest is waiting for a person with that system (or a CI runner). A blank is "not run", never "passed".

How to fill it in: follow the steps below on a clean machine or VM, then write the date, the build (version and installer file name) and who ran it. Record start-up and memory figures from `docs/runbooks/desktop-testing.md`.

| System       | Installer             | Installs (no admin) | Starts  | Seed loads | Update to mock next version | Uninstall keeps data, says so | Cold start | Memory (seed loaded) | Run by / date |
| ------------ | --------------------- | ------------------- | ------- | ---------- | --------------------------- | ----------------------------- | ---------- | -------------------- | ------------- |
| Windows 11   | NSIS per user, 8.1 MB | not run             | not run | not run    | not run                     | not run                       |            |                      |               |
| Windows 11   | MSI (per machine)     | not run             | not run | not run    | not run                     | not run                       |            |                      |               |
| Windows 10   | NSIS per user         | not run             | not run | not run    | not run                     | not run                       |            |                      |               |
| macOS 13     | DMG (universal)       | not run             | not run | not run    | not run                     | not run                       |            |                      |               |
| Ubuntu 22.04 | AppImage              | not run             | not run | not run    | not run                     | not run                       |            |                      |               |
| Ubuntu 22.04 | deb                   | not run             | not run | not run    | not run                     | not run                       |            |                      |               |

## What was done so far

- Windows 11 development machine: the NSIS installer was built (`GST Desk_0.0.0_x64-setup.exe`, **8.06 MiB**, under the 15 MB limit) and the Rust unit tests pass. It was **not** installed or run from the installer, and the other installers were not built here (they need their own operating systems; `desktop.yml` builds them).
- The WebDriver smoke test (`apps/desktop/e2e/smoke.mjs`) is written and wired into CI (`smoke` job in `desktop.yml`). It has not been run: running the Edge WebDriver it needs was refused in the session this was built in, so the first run will be CI's. See `docs/runbooks/desktop-testing.md`.

## Steps, on each system

1. **Install.** Windows: run the NSIS `*-setup.exe` as a normal user (no administrator prompt; an elevation prompt means the install is not per user). macOS: open the DMG and drag to Applications; first launch of an unsigned build needs right-click, Open. Linux: `chmod +x` the AppImage, or `sudo apt install ./gst-desk_*.deb`.
2. **Start.** The window opens; the language and mode steps show; the data folder is created (`%APPDATA%\GST Desk`, `~/Library/Application Support/GST Desk`, `~/.local/share/gst-desk`).
3. **Seed.** Choose "Try it with a sample business". The dashboard shows 500 documents. Settings, Desktop shows the data folder.
4. **Print.** Open a document, choose Print, and check the system print dialog opens (not covered by automation).
5. **Update.** Run a mock update server that serves a signed `latest.json` for a higher version (see the smoke test for a working one), set a debug build's address or publish to a test URL, and check: the bar says the version is ready, Restart to update restarts into it, and the data is all there. Then serve a tampered file and check the update is refused.
6. **Quick actions.** Tray icon: New bill opens a bill, Back up now makes a backup. Open a `.gstbk` from the file manager: the restore dialog opens on it. Open `gstdesk://inbox`: the inbox opens. Turn on Launch at login, sign out and in: the app starts in the tray.
7. **Uninstall.** Windows: Settings, Apps, uninstall; the message names `%APPDATA%\GST Desk`, and the folder is still there with the database and backups. Install again: everything is as it was.
8. **Measure.** Cold start to the dashboard showing numbers (target under 2 s on the baseline laptop) and memory with the seed loaded (target under 250 MB, app plus its WebView).

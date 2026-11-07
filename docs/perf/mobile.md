# Phone app: cold start

Budget (prompt 43, NFR-12): cold start under 2.5 s on a mid-range Android. **Reference device** for the
budget: a 4 GB phone of the Redmi Note 11 / Galaxy A14 class (Helio G88 / Exynos 1330, Android 13),
which is what a counter in a small shop is likely to hold. **It has not been measured on that device**
(B-178); the figures below are emulators on the development machine (8 cores, 15 GB, software GPU), which
are slower than a real phone on graphics and faster on everything else, so they are a sanity check, not
the result.

Cold start = `adb shell am start -W -n in.gstdesk.app/.MainActivity`, `TotalTime`: the process start to
the first frame of the activity. The web layer then opens the database and draws Home; that part is in
the e2e timings of the web app (first screen of the demo book under a second on the desktop budget).

| Device                                                              | Build                       | Run 1    | Run 2    | Run 3                                | Note                                                                  |
| ------------------------------------------------------------------- | --------------------------- | -------- | -------- | ------------------------------------ | --------------------------------------------------------------------- |
| Pixel 6a profile, Android 14 (API 34), x86_64 emulator, swiftshader | final debug APK, 2026-11-07 | 1,788 ms | 1,801 ms | 1,457 ms                             | process killed between runs; a synced business open                   |
| Pixel 4a profile, Android 11 (API 30), x86_64 emulator, swiftshader | final debug APK, 2026-11-07 | 1,892 ms | 1,879 ms | (3,653 ms first start after install) | to the "update WebView" page: the app itself cannot run on WebView 83 |

A debug APK is not optimised (no R8, no baseline profile, debuggable WebView); a release build starts
faster. The first start after install is slower on every Android (the WebView warms, the SQLite file is
made); the table is the second start on.

What is in the 52 MB debug APK: the web layer with its fonts and the sqlite-wasm it no longer uses on the
phone (B-185 trims it), Capacitor and the plugins, ML Kit's bundled barcode model. Size is not budgeted
by the PRD for the phone; the Play bundle is split per ABI and language.

# 0026 — The phone app: Capacitor around the web app

Status: accepted. Context: prompt 43, PRD FR-140, FR-141, UX-11, NFR-12.

## Decision

- **One codebase.** The phone app is the web app's React code in a Capacitor 8 shell (`apps/mobile`),
  not a second app. Capacitor 8 rather than the 6 the prompt names: 6 is out of support, the SQLite and
  PowerSync plugins need 8, and nothing in the prompt depends on 6. The shop shell on a phone is the
  phone layout (`features/mobile`): bottom tabs (Home, Bill, Parties, Inbox, More), thumb-sized targets,
  swipe actions, pull to refresh, a sticky total. `/shop/...` addresses are the same, so every link in
  the app lands in the right place; Books addresses redirect (Books on a phone is out of scope). A
  browser on a narrow touch screen gets the same layout; `?mobile=1` or `?mobile=0` decides by hand.
- **Native where the browser cannot.** `apps/web/src/platform/` is the only place that knows the
  platform: camera (with on-device downscaling), share sheet, ML Kit barcode, the device's speech
  recogniser, biometrics, push, WorkManager windows, and two plugins of our own in Java (Bluetooth
  Classic ESC/POS printing; background windows). Every bridge has a web fallback, so a feature never
  branches on the platform.
- **The database.** A local book on the phone is the community SQLite plugin behind the same `Backend`
  interface as the browser's worker and the desktop's Rust side; repositories run unchanged. A cloud
  business opens as a synced book through PowerSync's Capacitor client over the same native SQLite,
  with our schema as raw tables, exactly as the Node opener of prompt 41 does. The phone is the first
  app platform that runs the sync client; the browser still has none (B-167).
- **Billing on a phone** keeps the desktop's editor state (`useDocumentEditor`: engine pricing on every
  change, autosave, issue) under a one-handed screen: party sheet with recents, item sheet with
  favourites and the barcode, a quantity stepper, voice entry (device recogniser, then the Tier 0 parser,
  with Tier 1 or Tier 2 where the router has one), and after issuing the UPI QR on screen and the PDF two
  taps from WhatsApp through the system share sheet.
- **Capture never waits for the network.** A photographed bill is downscaled on the device, read by the
  OCR and the rules on the phone, and lands in the inbox. The model step runs on the phone only with
  WebGPU and a capable device; otherwise the item is marked `deferred: model` for a desktop with a local
  model, or the cloud (prompt 48), to finish. Finishing it elsewhere needs the attachment bytes to sync
  (B-169); until then the deferred item is complete as a rules-only extraction.
- **Battery.** Sync runs in the foreground, and in the background only inside WorkManager windows (every
  30 minutes at the earliest, network connected, battery not low). A window wakes the page's sync client
  if the process is alive; if not, nothing runs until the app opens. Push messages (data only: a kind
  and a count) wake a sync the same way.
- **Push** goes through FCM's HTTP v1 API from the cloud API with a service-account key; tokens are per
  user; the API sends on server-raised inbox items (conflicts, approvals). Reminders are raised on the
  device by Tier 0, so they notify locally when that lands (B-181).

## Android's SQLite bridge

Two things the Capacitor SQLite adapter does on Android shape `platform/capacitor/synced-book.ts`: a
statement that is not a SELECT runs through `executeSet`, which answers without rows, so an
`INSERT ... RETURNING` (every repository's way of reading back what it wrote) comes back empty; and the
SDK's transaction object answers `getAll` through that same path. The opener routes statements with
`RETURNING` down the query path (a raw query on the write connection inside the same lock) and runs
transactions as the SDK does (`BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK`) but on the lock's own context.
iOS has neither problem. Worth revisiting when the adapter changes (B-187).

## Consequences

- Measured on emulators, not phones: see `docs/qa/mobile-matrix.md` and `docs/perf/mobile.md`. The
  cold-start budget is stated against a reference device the matrix names; the figure here is an
  emulator's.
- iOS: the Xcode project is generated with its usage strings and builds nowhere in this repository
  (no macOS); store submission is out of scope.
- The app id `in.gstdesk.app` is a placeholder until the Play listing exists; it cannot change after.

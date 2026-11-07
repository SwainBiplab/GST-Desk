# Phone app: device matrix

Prompt 43's acceptance: the debug APK installs and runs the full billing flow on two reference devices. **No
real phone was available in the session that built this**; the two devices below are Android emulators on
the development machine (x86_64 system images, software GPU, no Play services). A blank is "not run", never
"passed". The reference phones for the budget are named in `docs/perf/mobile.md` (B-178).

| Device                                                                 | Build                    | Installs | Starts                                | Sign in (phone code) | Sync (first download)                                | Bill: party, item, stepper, issue                                                              | Share PDF                                                                                  | Capture a bill                                             | Cold start                                             | Run by / date      |
| ---------------------------------------------------------------------- | ------------------------ | -------- | ------------------------------------- | -------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------ | ------------------ |
| Pixel 6a profile, Android 14 (API 34), google_apis x86_64, WebView 113 | app-debug.apk 2026-11-07 | yes      | yes                                   | yes (Maestro 01)     | yes (02: the business arrives, the pill says Synced) | yes (03: INV/26-27/0001 and 0002 issued from the device's block, on the server within seconds) | yes (04: the system sheet opens with `Phone-Traders_26-27_Tax-Invoice_INV-26-27-0001.pdf`) | camera yes; the virtual scene has no text, so no card (05) | 1.5 to 1.8 s                                           | Claude, 2026-11-07 |
| Pixel 4a profile, Android 11 (API 30), google_apis x86_64, WebView 83  | app-debug.apk 2026-11-07 | yes      | shows "Update Android System WebView" | not run              | not run                                              | not run                                                                                        | not run                                                                                    | not run                                                    | 1.9 s to the message (3.7 s first start after install) | Claude, 2026-11-07 |

## What was found

- **The WebView floor is Chrome 100.** The Android 11 image ships WebView 83, which cannot parse the build;
  the app now says so on a plain page instead of staying blank. Real Android 10 and 11 phones get their
  WebView from Play and are usually far newer; an Android 11 phone with an updated WebView is expected to
  run, and is not verified (B-178).
- **Sign-in, sync, billing and sharing work from the phone against the development API** (`http://10.0.2.2:8787`,
  PowerSync at `:8080`). What had to change, all now part of the build:
  - the API answers CORS for the apps' origins (it had no CORS at all; the phone's page is `https://localhost`);
  - a debug build allows mixed content and cleartext to the development machine, and the address check
    allows plain http to private addresses in debug builds only;
  - `@powersync/capacitor` must be listed by `apps/mobile` too, or its native side is not built ("plugin is
    not implemented on android");
  - registering for push without `google-services.json` kills the process: the app now asks the native side
    whether Firebase exists first;
  - the live queries did not see rows PowerSync wrote: the sync runtime now announces PowerSync's table
    changes to them;
  - on Android the Capacitor adapter runs an `INSERT ... RETURNING` through a path that drops its rows, and
    the SDK's transaction object answers queries through that same path: the synced-book opener routes
    such statements down the query path and runs transactions on the lock's own context
    (`platform/capacitor/synced-book.ts`);
  - the phone's bill route remounted when the first autosave gave the draft its id, losing the customer just
    chosen; it now adopts the id as the desktop editor does.
- **Tier 0 runs on the phone and its items sync**: two customers with the same name made by two runs of
  the bill flow raised a duplicate-party card on the phone, which reached the server as a review item.
- **Maestro drives the WebView by HTML ids**, so in the phone app every element with a `data-testid` gets
  the same `id`; the flows in `apps/mobile/maestro` name those.
- **Camera on an emulator**: the capture flow opens the camera app of the system image; its shutter button
  id varies by image, so flow 05 is marked optional where it must be, and the emulator's "virtual scene"
  is what gets photographed.
- **Not covered by any device here**: barcode scanning (ML Kit needs Play services), Bluetooth printing
  (no paired printer), biometrics (the emulator has no enrolled fingerprint by default; `adb -e emu
finger touch 1` enrols one), push (no `google-services.json`), background windows (WorkManager runs; a
  window was not observed within the session).

## Usability run

Invoice creation under 2 minutes with three shopkeepers: **not run** (B-182). The Maestro bill flow on the
emulator (customer, item, quantity, issue) completes in under 20 seconds of taps, which says nothing about a
person.

## Steps, on each device

1. `adb install -r app-debug.apk`; open; the setup wizard shows (no business) or Home.
2. Sign in: wizard → "Sign in to a business that syncs instead" → API address, phone, code.
3. Choose the business; the first download shows its progress; Home shows the business.
4. New bill: choose a customer, add an item, step the quantity, Issue; the done screen shows the number
   and the share button (and the UPI QR when the business has a UPI id).
5. Share: the system sheet opens with the PDF.
6. Scan a bill: the camera opens; the photo lands in the inbox as a card.
7. Cold start: `adb shell am start -W -n in.gstdesk.app/.MainActivity`, three times after a force-stop.

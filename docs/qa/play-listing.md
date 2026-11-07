# Play Store listing: what to prepare

No store publication is part of prompt 43; this is the checklist for when it is.

- [ ] Package name final (`appId` in `apps/mobile/capacitor.config.ts`); it cannot change later.
- [ ] App icon 512×512 PNG; adaptive icon layers in `android/app/src/main/res/mipmap-*` (today: Capacitor's placeholder).
- [ ] Feature graphic 1024×500.
- [ ] Phone screenshots (at least 4): Home, Bill, done screen with the UPI QR, Inbox with a scanned bill.
- [ ] Short description (80 chars) and full description (4000 chars) in English and Hindi.
- [ ] Privacy policy URL (`docs/privacy.md` published).
- [ ] Data safety form: the book stays on the device unless sync is on; with sync, business data goes to the organisation's server; no advertising; crash reports only with telemetry on.
- [ ] Permissions explained in the listing: camera (bill photos, barcodes), microphone (voice billing), Bluetooth (receipt printers), notifications.
- [ ] Content rating questionnaire (business tool).
- [ ] Upload key and Play App Signing enrolled (`docs/runbooks/mobile.md`).
- [ ] Internal testing track first, with the two reference devices from `docs/qa/mobile-matrix.md`.

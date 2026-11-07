---
'web': minor
'api': minor
'@gst/sync': minor
---

The phone app (prompt 43). Capacitor 8 wraps the web app with a phone layout: bottom tabs, one-handed billing (party and item sheets with recents and favourites, a quantity stepper, barcode, voice), a sticky total, the UPI QR on screen after issuing, the PDF two taps from WhatsApp, pull to refresh and swipe actions. Native SQLite for local books and PowerSync's Capacitor client for synced ones (the first app platform with the sync client). Camera capture with on-device downscaling into the inbox, the model step deferred when the phone cannot run it. Sign in by phone code, choose a business, first sync with progress, offline indicator. App lock with biometrics, push through FCM, Bluetooth receipt printing, background sync confined to WorkManager windows. Android debug APK and Play listing checklist; the iOS project is generated.

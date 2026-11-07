# apps/mobile

The phone app (prompt 43): Capacitor 8 wrapping the web app's build with the phone layout
(`apps/web/src/features/mobile`), native SQLite, PowerSync, camera, barcode, share, push, biometrics
and Bluetooth printing (`apps/web/src/platform`). Android first; the iOS project is generated and
kept, not shipped.

## Build a debug APK

```
export JAVA_HOME=~/.local/toolchains/jdk-21 ANDROID_HOME=~/Android/Sdk
pnpm --filter mobile apk:debug
# apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

`build:web:debug` lets the app talk to an API on the development machine over plain http
(`http://10.0.2.2:8787` from an emulator). A release build (`bundle:release`) does not.

## Signing (release)

Put `keystore.properties` in `android/` (see `android/keystore.properties.example`); the Gradle file
reads it when present and leaves the build unsigned otherwise. The keystore and the file are ignored
by git. See `docs/runbooks/mobile.md`.

## Flows

`maestro/*.yaml` drive the app on a device or emulator: sign in, sync, bill, share, capture. Run with
`maestro test maestro` after `maestro` is installed (needs Java 17+).

## Native plugins of our own

`android/app/src/main/java/in/gstdesk/app/`: `BtPrinterPlugin` (Bluetooth Classic ESC/POS) and
`BackgroundSyncPlugin` (WorkManager windows). Both are registered in `MainActivity`.

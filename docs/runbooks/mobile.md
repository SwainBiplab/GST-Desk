# Runbook: the phone app

## Build

```
export JAVA_HOME=~/.local/toolchains/jdk-21 ANDROID_HOME=~/Android/Sdk
pnpm --filter mobile apk:debug        # apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
pnpm --filter mobile bundle:release   # app bundle for Play, signed when keystore.properties exists
```

The web layer is built with `VITE_TARGET=capacitor`; the debug script also allows plain http to the
development machine (`VITE_DEBUG_API=1` for the page's policy, `GST_DEBUG_API=1` at `cap sync` for the
WebView's mixed-content setting, and the debug manifest's cleartext grant) so an emulator reaches an API
at `http://10.0.2.2:8787`. Release builds allow https only.

## Sign

Make a keystore once (`keytool -genkeypair -v -keystore gst-desk-release.jks -alias gst-desk -keyalg RSA
-keysize 4096 -validity 10000`), keep it and its passwords in the secret store, and put
`android/keystore.properties` (from the `.example`) on the build machine. Play App Signing holds the
upload key; losing the keystore means a new listing.

## Push

Make a Firebase project, add the Android app with the package name, download `google-services.json`
into `android/app/` (ignored by git; CI writes it from a secret), and give the API the service account's
JSON key as `FCM_SERVICE_ACCOUNT_JSON`. Without either, the app runs and simply gets no pushes.

## Run on an emulator

```
avdmanager create avd -n pixel34 -k "system-images;android-34;google_apis;x86_64" -d pixel_6a
emulator -avd pixel34 &
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -W -n in.gstdesk.app/.MainActivity     # TotalTime is the cold start
```

The API for a sign-in test: `pnpm --filter api dev` with the sync stack (`docs/runbooks/sync.md`); the
emulator reaches it at `http://10.0.2.2:8787`.

## Flows

`maestro test apps/mobile/maestro` (Maestro in `~/.local/toolchains/maestro/bin`). Flows 01 and 02 need
the API; 03 to 05 run on a local book too.

## When something is wrong

| Symptom                                         | Likely cause                              | Do this                                                                       |
| ----------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| White screen at start                           | The web layer was not built or synced     | `pnpm --filter mobile build:web && cap sync android`, rebuild                 |
| "Sync is not configured" on sign-in             | The API has no `POWERSYNC_URL`            | see `docs/runbooks/sync.md`                                                   |
| Sign-in works, "Use on this phone" does nothing | The address is http on a release build    | use https, or a debug build                                                   |
| Barcode button missing                          | ML Kit module not available on the device | it installs from Play services on first use; emulators without Play have none |
| Print fails at once                             | Printer not paired, or Bluetooth off      | pair in the phone's settings, choose it under More                            |
| App lock never asks                             | No biometrics or PIN set on the phone     | the switch is hidden then                                                     |

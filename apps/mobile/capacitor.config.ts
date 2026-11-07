import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The phone app (prompt 43): Capacitor wraps the web app's build (`apps/web/dist`, made with
 * `VITE_TARGET=capacitor`) in a native shell. The app id is the Play Store package name; change it before
 * the first upload and never after.
 */
const config: CapacitorConfig = {
  appId: 'in.gstdesk.app',
  appName: 'GST Desk',
  webDir: '../web/dist',
  android: {
    // the page is https://localhost; a debug build may talk to a development API over plain http
    // (`GST_DEBUG_API=1` at `cap sync`, as the apk:debug script does). Release builds never do.
    allowMixedContent: process.env['GST_DEBUG_API'] === '1',
    backgroundColor: '#ffffff',
  },
  ios: { contentInset: 'automatic' },
  plugins: {
    SplashScreen: { launchShowDuration: 0, launchAutoHide: false },
    Keyboard: { resize: 'body' },
    CapacitorSQLite: {
      androidIsEncryption: false,
      androidBiometric: { biometricAuth: false },
    },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;

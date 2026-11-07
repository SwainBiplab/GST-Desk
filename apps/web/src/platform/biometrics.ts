/**
 * App lock (prompt 43): the phone's fingerprint or face, with the device PIN as the fallback. The lock
 * is a setting on the device, kept in Capacitor's preferences (not in the book, which syncs). A browser
 * has no biometrics, so the setting is simply not offered there.
 */
import { hasPlugin } from './index';

const KEY = 'app.lock';

export const appLockAvailable = async (): Promise<boolean> => {
  if (!hasPlugin('BiometricAuthNative')) return false;
  const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
  const info = await BiometricAuth.checkBiometry();
  return info.isAvailable || info.deviceIsSecure;
};

export async function readAppLock(): Promise<boolean> {
  if (!hasPlugin('Preferences')) return false;
  const { Preferences } = await import('@capacitor/preferences');
  return (await Preferences.get({ key: KEY })).value === '1';
}

export async function writeAppLock(on: boolean): Promise<void> {
  if (!hasPlugin('Preferences')) return;
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.set({ key: KEY, value: on ? '1' : '0' });
}

/** Ask the person to prove it is them. Resolves true when they did. */
export async function unlock(reason: string): Promise<boolean> {
  if (!hasPlugin('BiometricAuthNative')) return true;
  const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
  try {
    await BiometricAuth.authenticate({ reason, allowDeviceCredential: true });
    return true;
  } catch {
    return false;
  }
}

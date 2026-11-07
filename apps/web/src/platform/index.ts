/**
 * Where the app is running (prompt 43). The same React code runs in a browser, in the desktop app
 * (Tauri) and in the phone app (Capacitor); each native side is reached through the small bridges in
 * this folder, and every bridge has a web fallback, so a feature never asks "which platform" itself.
 */
import { Capacitor } from '@capacitor/core';

export type Platform = 'web' | 'desktop' | 'android' | 'ios';

export function platform(): Platform {
  if (typeof window === 'undefined') return 'web';
  if ('__TAURI_INTERNALS__' in window) return 'desktop';
  if (Capacitor.isNativePlatform()) return Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';
  return 'web';
}

/** Inside the phone app (Android or iOS), where the native plugins exist. */
export const isNativeApp = (): boolean => {
  const p = platform();
  return p === 'android' || p === 'ios';
};

/** Is a plugin's native side present? (A browser, or a build without it, answers no.) */
export const hasPlugin = (name: string): boolean =>
  isNativeApp() && Capacitor.isPluginAvailable(name);

const LAYOUT_KEY = 'gst.layout';

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
};

/**
 * The phone layout (one-handed billing, bottom tabs) is used in the phone app always, and in a browser
 * on a narrow touch screen; `?mobile=1` or `?mobile=0` on the address decides it by hand (the tests, and
 * a person who wants the shop layout on a tablet). The choice made by hand is remembered.
 */
export function isMobileLayout(): boolean {
  if (typeof window === 'undefined') return false;
  const asked = new URLSearchParams(window.location.search).get('mobile');
  if (asked === '1' || asked === '0') write(LAYOUT_KEY, asked === '1' ? 'mobile' : 'desktop');
  const chosen = read(LAYOUT_KEY);
  if (chosen === 'mobile') return true;
  if (chosen === 'desktop') return false;
  if (isNativeApp()) return true;
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 640px) and (pointer: coarse)').matches
  );
}

export const setMobileLayout = (on: boolean | null): void =>
  write(LAYOUT_KEY, on === null ? null : on ? 'mobile' : 'desktop');

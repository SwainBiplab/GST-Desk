import {
  LANGUAGE_KEY,
  PSEUDO,
  initialLanguage,
  isLanguage,
  setLanguage,
  setup,
  type Language,
} from '@gst/i18n';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { track } from '@/features/telemetry/telemetry';

/** What the app speaks now: a language, or the layout-test pseudo-locale. */
export type UiLanguage = Language | typeof PSEUDO;

function readStored(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_KEY);
  } catch {
    return null;
  }
}

/** `?lng=ta` (or `pseudo`) wins for one visit, so a language can be shared as a link and tested. */
function fromUrl(): UiLanguage | null {
  try {
    const v = new URLSearchParams(location.search).get('lng');
    if (v === PSEUDO || isLanguage(v)) return v;
  } catch {
    /* no location in a test */
  }
  return null;
}

function apply(lng: UiLanguage) {
  if (typeof document !== 'undefined') document.documentElement.lang = lng === PSEUDO ? 'en' : lng;
}

void i18n.use(initReactI18next);

/** Resolves once English (and the chosen language, if another) is loaded: render after this. */
export const i18nReady: Promise<void> = (async () => {
  const lng =
    fromUrl() ??
    initialLanguage(readStored(), typeof navigator === 'undefined' ? [] : navigator.languages);
  await setup(i18n, lng);
  apply(lng);
})();

/** Switch language without a reload, and remember it on this device. */
export async function changeLanguage(lng: UiLanguage): Promise<void> {
  await setLanguage(i18n, lng);
  apply(lng);
  track('language_changed');
  if (lng !== PSEUDO)
    try {
      localStorage.setItem(LANGUAGE_KEY, lng);
    } catch {
      /* storage may be blocked */
    }
}

export function currentLanguage(): Language {
  const l = i18n.language;
  return isLanguage(l) ? l : 'en';
}

export default i18n;

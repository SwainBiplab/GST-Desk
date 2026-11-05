import type { PrintLanguage } from '../print';

import type { en } from './en';
import type { errors, help } from './en-extra';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };

/** What a language file provides. Anything it leaves out is shown in English. */
export interface LocaleBundle {
  ui: DeepPartial<typeof en>;
  errors?: DeepPartial<typeof errors>;
  help?: DeepPartial<typeof help>;
}

/** Loaded on demand, so a person who only uses English never downloads another language. */
export const LOADERS: Record<Exclude<PrintLanguage, 'en'>, () => Promise<LocaleBundle>> = {
  hi: () => import('./hi').then((m) => m.bundle),
  ta: () => import('./ta').then((m) => m.bundle),
  mr: () => import('./mr').then((m) => m.bundle),
  bn: () => import('./bn').then((m) => m.bundle),
  gu: () => import('./gu').then((m) => m.bundle),
};

/** Key types generated from the English catalogue, so a mistyped key is a type error. */
import type { en } from './locales/en';
import type { errors, help } from './locales/en-extra';

type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every key in `ui`, including plural forms such as `inbox.count_one`. */
export type UiKey = Paths<typeof en>;

type PluralBase<K> = K extends `${infer B}_${'zero' | 'one' | 'two' | 'few' | 'many' | 'other'}`
  ? B
  : K;

/** What to pass to `t()` for `ui`: a key, or the base of a plural. */
export type UiTKey = PluralBase<UiKey>;

export type ErrorsKey = Paths<typeof errors>;
export type HelpKey = Paths<typeof help>;

export type Resources = {
  ui: typeof en;
  errors: typeof errors;
  help: typeof help;
  print: Record<string, unknown>;
};

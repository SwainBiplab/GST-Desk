import type { Resources } from '@gst/i18n';

/** Makes `t()` check its keys against the English catalogue: a mistyped key is a type error. */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'ui';
    resources: Resources;
  }
}

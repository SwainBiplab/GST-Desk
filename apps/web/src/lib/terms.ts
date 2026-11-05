import { term, type Concept, type Language } from '@gst/i18n';
import { isLanguage } from '@gst/i18n';
import { useTranslation } from 'react-i18next';

/** The glossary word for a GST term in the language of the screen (CGST, GSTIN, HSN and so on). */
export function useTerm(): (concept: Concept) => string {
  const { i18n } = useTranslation();
  const lang: Language = isLanguage(i18n.language) ? i18n.language : 'en';
  return (concept) => term(lang, concept);
}

/** Names that are the same in every language. */
export const BRAND = { google: 'Google Drive', onedrive: 'OneDrive' } as const;

/** Key names as printed on a keycap. */
export const KEYS = { commandBar: 'Ctrl+K', commandBarCap: 'Ctrl K', help: 'F1' } as const;

/** Examples shown in fields: a format, not words. */
export const EXAMPLE = { url: 'https://', documentNumber: 'INV/26-27/0001' } as const;

/** Paper widths. */
export const roll = (mm: number) => `${mm} mm`;

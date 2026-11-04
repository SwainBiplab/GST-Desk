import {
  FontMeasurer,
  SCRIPT_FAMILY,
  familiesIn,
  type FontBytes,
  type FontFamily,
  type PrintModel,
  type TemplateSpec,
} from '@gst/print';
import { loadFontsWeb, registerBrowserFonts } from '@gst/print/fonts.web';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

/** Every script a document needs: the template's language plus any script in its own text. */
export function familiesFor(model: PrintModel, spec: TemplateSpec): FontFamily[] {
  const out = new Set<FontFamily>(['latin', 'latinExt']);
  const lang = SCRIPT_FAMILY[spec.language];
  if (lang) out.add(lang);
  // names and addresses can be in any script, whatever the template language is
  const text =
    JSON.stringify(model, (_k, v) => (typeof v === 'bigint' ? '' : v)) +
    JSON.stringify(spec.labels);
  for (const f of familiesIn(text)) out.add(f);
  return [...out].sort();
}

export interface LoadedFonts {
  bytes: FontBytes;
  measurer: FontMeasurer;
}

const measurers = new Map<string, LoadedFonts>();

/** Load the fonts (once per set) and register them with the page so the SVG preview and printing use them. */
export async function loadFonts(families: readonly FontFamily[]): Promise<LoadedFonts> {
  const key = [...families].sort().join(',');
  const hit = measurers.get(key);
  if (hit) return hit;
  const bytes = await loadFontsWeb(families);
  await registerBrowserFonts(bytes);
  const loaded = { bytes, measurer: new FontMeasurer(bytes) };
  measurers.set(key, loaded);
  return loaded;
}

/** The fonts a document needs, or `null` while they load. */
export function usePrintFonts(families: readonly FontFamily[]): LoadedFonts | null {
  const key = useMemo(() => [...families].sort().join(','), [families]);
  const q = useQuery({
    queryKey: ['print-fonts', key],
    queryFn: () => loadFonts(key.split(',') as FontFamily[]),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return q.data ?? null;
}

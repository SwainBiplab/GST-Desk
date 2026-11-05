import { TemplateRepo, type Row, type Shell } from '@gst/db';
import type { PrintLanguage } from '@gst/i18n';
import {
  PRESET_IDS,
  TemplateError,
  parseTemplate,
  presetSpec,
  type TemplateSpec,
} from '@gst/print';
import { useMemo } from 'react';

import { useLiveQuery } from '@/app/db';

export interface TemplateOption {
  /** `preset:classic` or the saved template's id. */
  id: string;
  name: string;
  spec: TemplateSpec;
  saved: boolean;
  row: Row | null;
}

export const presetOptions = (): TemplateOption[] =>
  PRESET_IDS.map((id) => {
    const spec = presetSpec(id);
    return { id: `preset:${id}`, name: spec.name, spec, saved: false, row: null };
  });

/** The five shipped presets, then the business's own templates (any that no longer validate are left out). */
export function useTemplates(): { options: TemplateOption[]; loading: boolean } {
  const q = useLiveQuery<Row[]>({
    tables: ['templates'],
    key: ['templates'],
    fn: (d, c) => new TemplateRepo(d).listTemplates(c),
  });
  const options = useMemo(() => {
    const own: TemplateOption[] = [];
    for (const row of q.data ?? []) {
      try {
        own.push({
          id: String(row['id']),
          name: String(row['name']),
          spec: parseTemplate(row['config_json']),
          saved: true,
          row,
        });
      } catch (e) {
        if (!(e instanceof TemplateError)) throw e;
      }
    }
    return [...presetOptions(), ...own];
  }, [q.data]);
  return { options, loading: q.isLoading };
}

/** The id a document type uses by default in this shell. */
export function useDefaultTemplateId(documentType: string, shell: Shell): string {
  const q = useLiveQuery<string>({
    tables: ['settings', 'templates'],
    key: ['template-default', documentType, shell],
    fn: (d, c) => new TemplateRepo(d).resolveId(c, documentType, shell),
  });
  return q.data ?? 'preset:classic';
}

export const specOf = (options: readonly TemplateOption[], id: string): TemplateSpec =>
  (options.find((o) => o.id === id) ?? options[0]!).spec;

/**
 * A party can have its own language: their copy of a document prints in it whatever the template says,
 * and a party with none uses the template's (the business's) language.
 */
export const withPartyLanguage = (
  spec: TemplateSpec,
  party: { language?: PrintLanguage } | null | undefined,
): TemplateSpec => (party?.language ? { ...spec, language: party.language } : spec);

/**
 * Messages in the customer's language: a template is filled, and when a local model is on, rephrased.
 * The rephrasing is kept only if every number, amount and name in the template survived; the person
 * always sees the text before it is sent.
 */
import { z } from 'zod';

import type { AiRouter } from '../router';

export const paraphraseSchema = z.object({ text: z.string().min(1) });

export function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => String(vars[k] ?? ''));
}

/** Everything that must not change: digit runs (amounts, dates, invoice numbers). */
const anchors = (s: string): string[] =>
  (s.match(/\d[\d,./-]*/g) ?? []).map((x) => x.replace(/[,.]$/, ''));

export function paraphraseKeepsFacts(
  original: string,
  candidate: string,
  mustKeep: string[] = [],
): boolean {
  if (!candidate.trim()) return false;
  if (candidate.length < original.length * 0.4 || candidate.length > original.length * 2.5)
    return false;
  const c = candidate.toLowerCase();
  for (const a of anchors(original)) if (!candidate.includes(a)) return false;
  for (const k of mustKeep) if (k && !c.includes(k.toLowerCase())) return false;
  return true;
}

export interface DraftedMessage {
  text: string;
  paraphrased: boolean;
  provider: string | null;
}

export async function draftMessage(args: {
  template: string;
  vars: Record<string, string | number>;
  language: string;
  router?: AiRouter | undefined;
  /** Names that must appear unchanged, such as the customer's. */
  mustKeep?: string[];
  tone?: 'polite' | 'firm' | 'friendly';
  signal?: AbortSignal;
}): Promise<DraftedMessage> {
  const base = fillTemplate(args.template, args.vars);
  if (!args.router) return { text: base, paraphrased: false, provider: null };
  const r = await args.router.suggest(
    {
      feature: 'paraphrase',
      text: base,
      input: { language: args.language, tone: args.tone ?? 'polite' },
    },
    paraphraseSchema,
    { schemaName: 'paraphrase', ...(args.signal ? { signal: args.signal } : {}) },
  );
  if (
    r.ok &&
    r.provider !== 'rules' &&
    paraphraseKeepsFacts(base, r.value.text, args.mustKeep ?? [])
  )
    return { text: r.value.text.trim(), paraphrased: true, provider: r.provider };
  return { text: base, paraphrased: false, provider: null };
}

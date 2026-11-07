/**
 * The shared path from "a feature wants a value of this shape" to "a validated value": pick the prompt
 * spec, ask a backend for text, pull the JSON out, convert rupees to paise, validate against the schema.
 * Every local backend goes through here so they behave alike.
 */
import { z } from 'zod';

import { fail, validated, type AiResult, type AiUsage, type Schema } from '../provider';

import { extractJson, gbnf } from './grammar';
import { promptFor } from './prompts';

export interface ChatTurn {
  role: 'system' | 'user';
  content: string;
}

export interface Generation {
  text: string;
  usage?: AiUsage;
}

/** A backend turns messages into text, constrained by a grammar or a JSON schema when it can. */
export type Generate = (
  messages: ChatTurn[],
  constraint: { grammar: string; jsonSchema: unknown },
  signal?: AbortSignal,
) => Promise<Generation>;

/** The schema the backend is constrained to: the prompt's rupee shape when there is a post step, else the caller's. */
function wireSchema<T>(schema: Schema<T>, name: string | undefined): z.ZodType {
  if (name === 'purchaseBill')
    return z.object({
      supplierName: z.string(),
      supplierGstin: z.string().nullable(),
      invoiceNumber: z.string(),
      date: z.string(),
      lines: z.array(
        z.object({
          description: z.string(),
          hsn: z.string().nullable(),
          qty: z.number(),
          rate: z.number(),
          gstRate: z.number(),
        }),
      ),
      total: z.number(),
    });
  if (name === 'voiceDraft')
    return z.object({
      intent: z.enum(['sale', 'purchase', 'payment', 'unknown']),
      party: z.string().nullable(),
      lines: z.array(
        z.object({
          description: z.string(),
          qty: z.number(),
          unit: z.string().nullable(),
          rate: z.number().nullable(),
        }),
      ),
      amount: z.number().nullable(),
    });
  return schema;
}

export async function generateStructured<T>(args: {
  generate: Generate;
  provider: string;
  model: string;
  schema: Schema<T>;
  name: string | undefined;
  text?: string | undefined;
  input?: unknown;
  signal?: AbortSignal | undefined;
  /** Confidence to report for a validated answer; the pipeline refines it with its own checks. */
  confidence?: number;
}): Promise<AiResult<T>> {
  const spec = promptFor(args.name);
  if (!spec) return fail('unsupported', `no prompt for "${args.name ?? 'unknown'}"`, true);
  const wire = wireSchema(args.schema, args.name);
  const started = performance.now();
  let gen: Generation;
  try {
    gen = await args.generate(
      [
        { role: 'system', content: spec.system },
        { role: 'user', content: spec.user({ text: args.text, input: args.input }) },
      ],
      { grammar: gbnf(wire), jsonSchema: z.toJSONSchema(wire) },
      args.signal,
    );
  } catch (e) {
    if (args.signal?.aborted) return fail('cancelled', 'request cancelled');
    return fail('unavailable', e instanceof Error ? e.message : String(e), true);
  }
  const raw = extractJson(gen.text);
  if (raw === undefined) return fail('invalid_output', 'the model did not answer with JSON', true);
  const candidate = spec.post ? spec.post(raw) : raw;
  return validated(args.schema, candidate, {
    provider: args.provider,
    model: args.model,
    confidence: args.confidence ?? 0.7,
    ...(gen.usage ? { usage: gen.usage } : {}),
    latencyMs: Math.round(performance.now() - started),
  });
}

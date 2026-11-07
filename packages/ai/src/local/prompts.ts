/**
 * What the small model is asked. Short, in English, with the schema spelled out as an example, because a
 * 1 to 2 billion parameter model follows an example better than a description. Numbers are asked for
 * in rupees with decimals; the code turns them into paise, so the model never has to multiply.
 */

export interface PromptSpec {
  system: string;
  user: (input: { text?: string | undefined; input?: unknown }) => string;
  /** Turn the model's rupee-and-decimal answer into the schema's integer paise. */
  post?: (raw: unknown) => unknown;
}

const rupeesToPaise = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export const PROMPTS: Record<string, PromptSpec> = {
  purchaseBill: {
    system:
      'You read Indian GST purchase invoices. Answer only with JSON. Dates are YYYY-MM-DD. ' +
      'Money is in rupees with two decimals. GST rate is a percentage (0, 5, 12, 18, 28). ' +
      'Use null when a value is not on the bill. Do not invent lines.',
    user: ({ text }) =>
      `Invoice text (from a scan):\n"""\n${(text ?? '').slice(0, 6000)}\n"""\n` +
      'Return: {"supplierName": string, "supplierGstin": string|null, "invoiceNumber": string, ' +
      '"date": "YYYY-MM-DD", "lines": [{"description": string, "hsn": string|null, "qty": number, ' +
      '"rate": number, "gstRate": number}], "total": number}',
    post: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const lines = Array.isArray(r['lines']) ? (r['lines'] as Record<string, unknown>[]) : [];
      return {
        supplierName: String(r['supplierName'] ?? ''),
        supplierGstin: r['supplierGstin'] ? String(r['supplierGstin']).toUpperCase() : null,
        invoiceNumber: String(r['invoiceNumber'] ?? ''),
        date: String(r['date'] ?? ''),
        lines: lines.map((l) => ({
          description: String(l['description'] ?? ''),
          hsn: l['hsn'] ? String(l['hsn']) : null,
          qty: Number(l['qty'] ?? 0),
          ratePaise: rupeesToPaise(l['rate']),
          gstRateBp: Math.round(Number(l['gstRate'] ?? 0) * 100),
        })),
        totalPaise: rupeesToPaise(r['total']),
      };
    },
  },
  voiceDraft: {
    system:
      'You turn what a shopkeeper said into a bill draft. The speech may be Hindi, Hinglish, Tamil, Marathi ' +
      'or English. Answer only with JSON. Quantities are numbers; rate is rupees per unit or null. ' +
      'Party is the customer or supplier name or null. Do not invent items.',
    user: ({ text }) =>
      `Said: """${(text ?? '').slice(0, 2000)}"""\n` +
      'Return: {"intent": "sale"|"purchase"|"payment"|"unknown", "party": string|null, ' +
      '"lines": [{"description": string, "qty": number, "unit": string|null, "rate": number|null}], ' +
      '"amount": number|null}',
    post: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const lines = Array.isArray(r['lines']) ? (r['lines'] as Record<string, unknown>[]) : [];
      return {
        intent: ['sale', 'purchase', 'payment'].includes(String(r['intent']))
          ? r['intent']
          : 'unknown',
        party: r['party'] ? String(r['party']) : null,
        lines: lines.map((l) => ({
          description: String(l['description'] ?? ''),
          qty: Number(l['qty'] ?? 0),
          unit: l['unit'] ? String(l['unit']) : null,
          ratePaise:
            l['rate'] === null || l['rate'] === undefined ? null : rupeesToPaise(l['rate']),
        })),
        amountPaise:
          r['amount'] === null || r['amount'] === undefined ? null : rupeesToPaise(r['amount']),
      };
    },
  },
  paraphrase: {
    system:
      'You rewrite a short business message so it reads naturally in the language it is written in. ' +
      'Keep every number, amount, date and name exactly as they are. Keep it polite and short. Answer only with JSON.',
    user: ({ text, input }) => {
      const i = (input ?? {}) as { language?: string; tone?: string };
      return `Language: ${i.language ?? 'the same as the message'}. Tone: ${i.tone ?? 'polite'}.\nMessage: """${(text ?? '').slice(0, 1500)}"""\nReturn: {"text": string}`;
    },
  },
  hsnPick: {
    system:
      'You choose the best HSN or SAC code for an item description from a list of candidates. ' +
      'Answer only with JSON and only with codes from the list.',
    user: ({ input }) => {
      const i = (input ?? {}) as {
        description?: string;
        candidates?: { code: string; description: string }[];
      };
      const list = (i.candidates ?? []).map((c) => `${c.code}: ${c.description}`).join('\n');
      return `Item: ${i.description ?? ''}\nCandidates:\n${list}\nReturn: {"code": string, "why": string}`;
    },
  },
};

/** The spec for a feature or schema name, if the local backends know how to ask for it. */
export const promptFor = (name: string | undefined): PromptSpec | undefined =>
  name ? PROMPTS[name] : undefined;

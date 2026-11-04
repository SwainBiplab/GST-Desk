/** HSN/SAC lookup sources. The DB-backed one lives in `@gst/ai/db`; this file is browser-safe. */

export interface HsnEntryLite {
  code: string;
  description: string;
  rate_bp: number;
  cess_bp?: number;
}

export interface HsnSuggestion {
  code: string;
  description: string;
  rateBp: number;
  cessBp: number;
  /** Relative relevance, higher is better. Comparable only within one result list. */
  score: number;
}

export interface HsnLookup {
  search(text: string, limit: number): Promise<HsnSuggestion[]>;
}

const STOP = new Set([
  'a',
  'an',
  'and',
  'or',
  'of',
  'the',
  'in',
  'for',
  'with',
  'to',
  'other',
  'others',
  'than',
  'not',
  'whether',
  'or',
  'nes',
  'etc',
  'including',
  'similar',
  'such',
  'as',
]);

/** Lowercase word tokens with a light plural strip, so "wires" matches "wire". */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .filter((w) => !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/**
 * In-memory BM25 (k1 = 1.2, b = 0.75) over descriptions. Same ranking idea as SQLite FTS5, so the
 * rules provider works offline in the browser before a database is wired in.
 */
export class InMemoryHsnLookup implements HsnLookup {
  private readonly docs: { entry: HsnEntryLite; tf: Map<string, number>; len: number }[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(entries: HsnEntryLite[]) {
    this.docs = entries.map((entry) => {
      const toks = tokenize(`${entry.code} ${entry.description}`);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { entry, tf, len: toks.length };
    });
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
  }

  async search(text: string, limit: number): Promise<HsnSuggestion[]> {
    const q = [...new Set(tokenize(text))];
    const n = this.docs.length;
    const scored: HsnSuggestion[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * (f * 2.2)) / (f + 1.2 * (0.25 + 0.75 * (d.len / this.avgLen)));
      }
      if (score > 0) {
        scored.push({
          code: d.entry.code,
          description: d.entry.description,
          rateBp: d.entry.rate_bp,
          cessBp: d.entry.cess_bp ?? 0,
          score,
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code)).slice(0, limit);
  }
}

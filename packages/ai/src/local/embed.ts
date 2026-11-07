/**
 * Vectors for HSN search. The real vectors come from a local embedding model; `HashEmbedder` is the
 * no-model fallback: character trigrams hashed into a fixed space, which forgives spelling ("mobil
 * chrger") and partial words but knows no synonyms. The hybrid lookup adds either to BM25.
 */
import type { HsnEntryLite, HsnLookup, HsnSuggestion } from '../rules/hsn';

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function normalise(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** FNV-1a over a string, for the hashing trick. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export class HashEmbedder implements Embedder {
  readonly model: string;
  constructor(readonly dims = 256) {
    this.model = `hash-trigram-v1-${dims}`;
  }

  one(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const w of words) {
      const padded = ` ${w} `;
      for (let i = 0; i + 3 <= padded.length; i++) {
        const h = fnv(padded.slice(i, i + 3));
        v[h % this.dims]! += h & 1 ? 1 : -1;
      }
      // whole words count too, so an exact word outranks a shared fragment
      const hw = fnv(`#${w}`);
      v[hw % this.dims]! += hw & 1 ? 2 : -2;
    }
    return normalise(v);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.one(t));
  }
}

export interface HsnVector {
  code: string;
  description: string;
  rateBp: number;
  cessBp: number;
  vector: Float32Array;
}

/** Brute force over the HSN master: ten thousand rows of 256 floats is a few milliseconds. */
export class HsnVectorIndex {
  constructor(readonly rows: HsnVector[]) {}

  search(q: Float32Array, limit: number): (HsnVector & { score: number })[] {
    const scored = this.rows.map((r) => ({ ...r, score: cosine(q, r.vector) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

export async function buildHsnVectors(
  entries: HsnEntryLite[],
  embedder: Embedder,
  batch = 64,
): Promise<HsnVector[]> {
  const out: HsnVector[] = [];
  for (let i = 0; i < entries.length; i += batch) {
    const slice = entries.slice(i, i + batch);
    const vecs = await embedder.embed(slice.map((e) => `${e.code} ${e.description}`));
    slice.forEach((e, j) =>
      out.push({
        code: e.code,
        description: e.description,
        rateBp: e.rate_bp,
        cessBp: e.cess_bp ?? 0,
        vector: vecs[j]!,
      }),
    );
  }
  return out;
}

const minMax = (xs: number[]): ((x: number) => number) => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return hi > lo ? (x) => (x - lo) / (hi - lo) : () => 1;
};

/**
 * BM25 and vectors together: each list's scores are scaled to 0..1 and summed with weights, so a code
 * found by both ways comes first, and a misspelt query still finds its code through the vector side.
 */
export class HybridHsnLookup implements HsnLookup {
  constructor(
    private readonly lexical: HsnLookup,
    private readonly index: HsnVectorIndex,
    private readonly embedder: Embedder,
    private readonly weights = { lexical: 0.55, vector: 0.45 },
  ) {}

  async search(text: string, limit: number): Promise<HsnSuggestion[]> {
    const wide = Math.max(limit * 10, 30);
    const [lex, [q]] = await Promise.all([
      this.lexical.search(text, wide),
      this.embedder.embed([text]),
    ]);
    const vec = this.index.search(q!, wide);
    const byCode = new Map<string, HsnSuggestion & { l: number; v: number }>();
    const nl = minMax(lex.map((h) => h.score));
    const nv = minMax(vec.map((h) => h.score));
    for (const h of lex) byCode.set(h.code, { ...h, l: nl(h.score), v: 0 });
    for (const h of vec) {
      const cur = byCode.get(h.code);
      if (cur) cur.v = nv(h.score);
      else
        byCode.set(h.code, {
          code: h.code,
          description: h.description,
          rateBp: h.rateBp,
          cessBp: h.cessBp,
          score: 0,
          l: 0,
          v: nv(h.score),
        });
    }
    return [...byCode.values()]
      .map(({ l, v, ...h }) => ({
        ...h,
        score: this.weights.lexical * l + this.weights.vector * v,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

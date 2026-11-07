/**
 * The curated GST corpus for Q&A with citations (prompt 48): markdown files under `content/gst-corpus/`, each
 * with a title, source link and date in front matter, chunked by heading and indexed with BM25 at build time
 * (`scripts/build-corpus.ts` writes `data/gst-corpus.json`). Retrieval here is pure: the gateway picks the top
 * chunks for a question and hands them to the model as documents with citations on.
 */

export interface CorpusChunk {
  id: string;
  /** The file's title. */
  title: string;
  /** The heading inside the file, or the title again. */
  heading: string;
  source: string;
  date: string;
  text: string;
}

export interface CorpusIndex {
  version: 1;
  builtAt: string;
  chunks: CorpusChunk[];
}

export interface Retrieved extends CorpusChunk {
  score: number;
}

const STOP = new Set(
  'a an and are as at be by for from has have in is it its of on or that the this to was were will with what when how does do under per'.split(
    ' ',
  ),
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Split a markdown document into chunks by heading, keeping each under about 1,500 characters. */
export function chunkMarkdown(
  file: { id: string; title: string; source: string; date: string; body: string },
  maxChars = 1500,
): CorpusChunk[] {
  const out: CorpusChunk[] = [];
  const sections = file.body.split(/\n(?=#{1,3} )/);
  let n = 0;
  for (const section of sections) {
    const lines = section.trim().split('\n');
    const first = lines[0] ?? '';
    const heading = /^#{1,3} /.test(first) ? first.replace(/^#{1,3} /, '').trim() : file.title;
    const body = (/^#{1,3} /.test(first) ? lines.slice(1) : lines).join('\n').trim();
    if (!body) continue;
    // long sections are split on paragraph breaks
    const paras = body.split(/\n{2,}/);
    let buf = '';
    const flush = () => {
      if (!buf.trim()) return;
      out.push({
        id: `${file.id}#${++n}`,
        title: file.title,
        heading,
        source: file.source,
        date: file.date,
        text: buf.trim(),
      });
      buf = '';
    };
    for (const p of paras) {
      if (buf.length + p.length > maxChars && buf) flush();
      buf += (buf ? '\n\n' : '') + p;
    }
    flush();
  }
  return out;
}

/** Front matter (`---` block with `key: value` lines) and the body of a corpus file. */
export function parseCorpusFile(
  id: string,
  raw: string,
): { id: string; title: string; source: string; date: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const meta: Record<string, string> = {};
  if (m) {
    for (const line of m[1]!.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return {
    id,
    title: meta['title'] ?? id,
    source: meta['source'] ?? '',
    date: meta['date'] ?? '',
    body: m ? m[2]! : raw,
  };
}

/** BM25 over the chunks; small enough to score every chunk per question. */
export class CorpusSearch {
  private readonly df = new Map<string, number>();
  private readonly docs: { chunk: CorpusChunk; tf: Map<string, number>; len: number }[];
  private readonly avgLen: number;

  constructor(readonly chunks: CorpusChunk[]) {
    this.docs = chunks.map((chunk) => {
      const ws = tokens(`${chunk.title} ${chunk.heading} ${chunk.text}`);
      const tf = new Map<string, number>();
      for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      return { chunk, tf, len: ws.length };
    });
    this.avgLen = this.docs.reduce((a, d) => a + d.len, 0) / Math.max(1, this.docs.length);
  }

  search(question: string, limit = 6): Retrieved[] {
    const q = [...new Set(tokens(question))];
    const N = this.docs.length;
    const k1 = 1.4;
    const b = 0.75;
    const scored = this.docs.map((d) => {
      let s = 0;
      for (const w of q) {
        const f = d.tf.get(w) ?? 0;
        if (!f) continue;
        const n = this.df.get(w) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen)));
      }
      return { ...d.chunk, score: s };
    });
    return scored
      .filter((r) => r.score > 0)
      .sort((a, c) => c.score - a.score)
      .slice(0, limit);
  }
}

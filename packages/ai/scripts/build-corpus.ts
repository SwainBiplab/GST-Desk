/**
 * pnpm --filter @gst/ai ai:corpus
 * Chunks and indexes `content/gst-corpus/*.md` into `data/gst-corpus.json`, which the cloud gateway loads and
 * searches (BM25 at query time; the file holds the chunks). Run after editing a corpus file; commit the output.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chunkMarkdown, parseCorpusFile, type CorpusIndex } from '../src/cloud/corpus';

const src = join(import.meta.dirname, '..', '..', '..', 'content', 'gst-corpus');
const out = join(import.meta.dirname, '..', 'data', 'gst-corpus.json');

const files = readdirSync(src)
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .sort();
const chunks = files.flatMap((f) =>
  chunkMarkdown(parseCorpusFile(f.replace(/\.md$/, ''), readFileSync(join(src, f), 'utf8'))),
);
for (const c of chunks) {
  if (!c.source || !c.date) throw new Error(`${c.id}: every corpus file needs source and date`);
}
const index: CorpusIndex = { version: 1, builtAt: new Date().toISOString().slice(0, 10), chunks };
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`);
console.log(`${files.length} files, ${chunks.length} chunks -> ${out}`);

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { load, type Vector } from '../scripts/vector-io';
import { computeDocument, type DocumentOptions, type LineInput } from '../src';

const dir = join(import.meta.dirname, 'vectors');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const all = files.flatMap((f) =>
  load<Vector[]>(readFileSync(join(dir, f), 'utf8')).map((v) => ({ file: f, v })),
);

describe('golden vectors', () => {
  it('has at least 150 cases', () => {
    expect(all.length).toBeGreaterThanOrEqual(150);
  });

  describe.each(files)('%s', (file) => {
    for (const { v } of all.filter((x) => x.file === file)) {
      it(`${v.name} [${v.rule}]`, () => {
        const { result, trace } = computeDocument(
          v.input.lines as LineInput[],
          v.input.options as unknown as DocumentOptions,
        );
        for (const [k, want] of Object.entries(v.expect.totals)) {
          expect(
            String((result.totals as unknown as Record<string, bigint>)[k]),
            `totals.${k}`,
          ).toBe(String(want));
        }
        v.expect.lines?.forEach((want, i) => {
          for (const [k, w] of Object.entries(want)) {
            expect(
              String((result.lines[i] as unknown as Record<string, bigint>)[k]),
              `lines[${i}].${k}`,
            ).toBe(String(w));
          }
        });
        expect(trace.length).toBeGreaterThan(0);
      });
    }
  });
});

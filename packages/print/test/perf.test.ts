import { beforeAll, describe, expect, it } from 'vitest';

import { presetSpec } from '../src';
import { FontMeasurer, type FontBytes } from '../src/fonts';
import { loadFontsNode } from '../src/fonts.node';
import { layoutDocument } from '../src/layout';

import { sampleModel } from './helpers';

let measurer: FontMeasurer;
beforeAll(() => {
  const fonts: FontBytes = loadFontsNode(['latin', 'latinExt', 'devanagari']);
  measurer = new FontMeasurer(fonts);
});

describe('layout speed', () => {
  it('lays out 200 lines in well under 100 ms (the preview must follow an edit in 300 ms)', () => {
    const model = sampleModel({ lines: 200 });
    const spec = presetSpec('classic');
    layoutDocument(model, spec, { measurer }); // warm the glyph cache
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      layoutDocument(model, spec, { measurer });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[2]!).toBeLessThan(100);
  });

  it('a cold first layout of a 50-line invoice is quick too', () => {
    const fresh = new FontMeasurer(loadFontsNode(['latin', 'latinExt']));
    const t0 = performance.now();
    layoutDocument(sampleModel({ lines: 50 }), presetSpec('classic'), { measurer: fresh });
    expect(performance.now() - t0).toBeLessThan(400);
  });
});

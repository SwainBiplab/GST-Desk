import { describe, expect, it } from 'vitest';

import { paraphraseGuard } from './ai-test-helpers';
import { chooseOcrEngine } from './ocr';
import { DEFAULT_AI_SETTINGS } from './settings';

describe('choosing the OCR engine', () => {
  it('is none without downloaded language data, a fixture in demo mode, and never the sidecar in a browser', () => {
    expect(chooseOcrEngine(DEFAULT_AI_SETTINGS, false)).toEqual({ engine: null, why: 'none' });
    const demo = chooseOcrEngine(DEFAULT_AI_SETTINGS, true);
    expect(demo.why).toBe('demo');
    expect(demo.engine?.id).toBe('fixture');
    expect(
      chooseOcrEngine({ ...DEFAULT_AI_SETTINGS, ocr: 'sidecar', ocrModelId: 'x' }, false).engine,
    ).toBeNull();
  });
  it('helper keeps the facts of a message', () => {
    expect(paraphraseGuard('Rs 500 due 1/2', 'Please pay Rs 500 by 1/2')).toBe(true);
  });
});

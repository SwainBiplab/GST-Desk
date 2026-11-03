import { describe, expect, it } from 'vitest';

import { AI_PACKAGE } from './index';

describe('@gst/ai', () => {
  it('exports its package constant', () => {
    expect(AI_PACKAGE).toBe('@gst/ai');
  });
});

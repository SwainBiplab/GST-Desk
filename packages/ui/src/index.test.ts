import { describe, expect, it } from 'vitest';

import { UI_PACKAGE } from './index';

describe('@gst/ui', () => {
  it('exports its package constant', () => {
    expect(UI_PACKAGE).toBe('@gst/ui');
  });
});

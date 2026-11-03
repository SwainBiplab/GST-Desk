import { describe, expect, it } from 'vitest';

import { I18N_PACKAGE } from './index';

describe('@gst/i18n', () => {
  it('exports its package constant', () => {
    expect(I18N_PACKAGE).toBe('@gst/i18n');
  });
});

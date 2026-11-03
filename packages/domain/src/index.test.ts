import { describe, expect, it } from 'vitest';

import { DOMAIN_PACKAGE } from './index';

describe('@gst/domain', () => {
  it('exports its package constant', () => {
    expect(DOMAIN_PACKAGE).toBe('@gst/domain');
  });
});

import { describe, expect, it } from 'vitest';

import { DB_PACKAGE } from './index';

describe('@gst/db', () => {
  it('exports its package constant', () => {
    expect(DB_PACKAGE).toBe('@gst/db');
  });
});

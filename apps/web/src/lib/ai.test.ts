import { afterEach, describe, expect, it, vi } from 'vitest';

import { aiRouter, suggestHsn } from './ai';

afterEach(() => vi.unstubAllGlobals());

describe('offline AI from the web app', () => {
  it('suggests HSN codes with the rules provider and never touches the network', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network is off')));
    vi.stubGlobal('fetch', fetchSpy);
    const hits = await suggestHsn('steel pipes');
    expect(hits[0]?.code).toBe('7306');
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes only to the rules provider', () => {
    expect(aiRouter.plan('suggest').map((p) => p.id)).toEqual(['rules']);
    expect(aiRouter.cloudAvailable('suggest')).toBe(false);
  });
});

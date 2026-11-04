import { afterEach, describe, expect, it, vi } from 'vitest';

import { canResetLocalData, resetLocalData } from './reset-local';

const fakeRoot = (names: string[], failOn?: string) => {
  const removed: string[] = [];
  return {
    removed,
    root: {
      async *entries() {
        for (const n of names) yield [n, {}] as [string, unknown];
      },
      async removeEntry(name: string) {
        if (name === failOn) throw new Error('locked by another window');
        removed.push(name);
      },
    },
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('reset local data', () => {
  it('removes every stored entry and clears saved preferences', async () => {
    const { root, removed } = fakeRoot(['gst-desk', 'blobs']);
    const cleared: string[] = [];
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    vi.stubGlobal('localStorage', { clear: () => cleared.push('local') });
    vi.stubGlobal('sessionStorage', { clear: () => cleared.push('session') });
    await resetLocalData();
    expect(removed).toEqual(['gst-desk', 'blobs']);
    expect(cleared).toEqual(['local', 'session']);
  });

  it('keeps going and reports what could not be removed', async () => {
    const { root, removed } = fakeRoot(['gst-desk', 'blobs'], 'gst-desk');
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    vi.stubGlobal('localStorage', { clear: () => undefined });
    vi.stubGlobal('sessionStorage', { clear: () => undefined });
    await expect(resetLocalData()).rejects.toThrow(/gst-desk: locked by another window/);
    expect(removed).toEqual(['blobs']);
  });

  it('is offered only where the browser can do it', () => {
    vi.stubGlobal('navigator', { storage: {} });
    expect(canResetLocalData()).toBe(false);
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({}) } });
    expect(canResetLocalData()).toBe(true);
  });
});

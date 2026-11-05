import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCATION,
  activeLocation,
  confirmSwitch,
  forgetPrevious,
  previousLocation,
  revertSwitch,
  stagingLocation,
  switchPending,
  switchTo,
  takeFellBackNotice,
} from './db-location';

function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('sessionStorage', storage());
});

describe('which database the app opens', () => {
  it('is the default one until a restore changes it', () => {
    expect(activeLocation()).toEqual(DEFAULT_LOCATION);
    expect(previousLocation()).toBeNull();
    expect(switchPending()).toBe(false);
  });

  it('points at the restored copy and remembers the one before it', () => {
    const next = stagingLocation(1000);
    switchTo(next, 5000);
    expect(activeLocation()).toEqual(next);
    expect(previousLocation()).toEqual({ location: DEFAULT_LOCATION, since: 5000 });
    expect(switchPending()).toBe(true);
  });

  it('keeps the new copy once it has opened', () => {
    switchTo(stagingLocation(1));
    confirmSwitch();
    expect(switchPending()).toBe(false);
    expect(activeLocation()).toEqual(stagingLocation(1));
    // nothing to go back to now that it is confirmed
    expect(revertSwitch()).toBeNull();
    expect(activeLocation()).toEqual(stagingLocation(1));
  });

  it('goes back to the previous copy when the new one will not open, and says so once', () => {
    switchTo(stagingLocation(1));
    expect(revertSwitch()).toEqual(DEFAULT_LOCATION);
    expect(activeLocation()).toEqual(DEFAULT_LOCATION);
    expect(switchPending()).toBe(false);
    expect(takeFellBackNotice()).toBe(true);
    expect(takeFellBackNotice()).toBe(false);
  });

  it('chains: a second restore keeps the first restored copy as its way back', () => {
    const a = stagingLocation(1);
    const b = stagingLocation(2);
    switchTo(a);
    confirmSwitch();
    switchTo(b);
    expect(previousLocation()!.location).toEqual(a);
    expect(revertSwitch()).toEqual(a);
  });

  it('forgets the previous copy when asked, returning where its files are', () => {
    switchTo(stagingLocation(1));
    confirmSwitch();
    expect(forgetPrevious()).toEqual(DEFAULT_LOCATION);
    expect(previousLocation()).toBeNull();
    expect(forgetPrevious()).toBeNull();
  });

  it('ignores a damaged setting and falls back to the default', () => {
    localStorage.setItem('gst.db.active', '{"dir":"no-slash","file":3}');
    expect(activeLocation()).toEqual(DEFAULT_LOCATION);
    localStorage.setItem('gst.db.active', 'not json');
    expect(activeLocation()).toEqual(DEFAULT_LOCATION);
  });

  it('names staging copies so that two never clash', () => {
    expect(stagingLocation(1).dir).not.toBe(stagingLocation(2).dir);
    expect(stagingLocation(1).dir.startsWith('/gst-desk-restore-')).toBe(true);
  });

  it('survives storage that refuses to work', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(activeLocation()).toEqual(DEFAULT_LOCATION);
    expect(() => switchTo(stagingLocation(1))).not.toThrow();
    expect(revertSwitch()).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { IDLE, pillState, type SyncStatus } from './status';

const on = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  ...IDLE,
  attached: true,
  connected: true,
  lastSyncedAt: 1,
  ...over,
});

describe('the sync pill', () => {
  it('says local for a local book, whatever else is going on', () => {
    expect(pillState('local', on({ pending: 3 }), 2).kind).toBe('local');
  });
  it('puts a conflict first, then a stuck upload, then offline, pending, syncing and synced', () => {
    expect(pillState('synced', on({ pending: 2 }), 1)).toEqual({
      kind: 'conflict',
      count: 1,
      tone: 'danger',
    });
    expect(pillState('synced', on({ pending: 2, errors: [{ at: 1, message: 'x' }] }), 0)).toEqual({
      kind: 'error',
      count: 2,
      tone: 'danger',
    });
    expect(pillState('synced', on({ connected: false, pending: 4 }), 0)).toEqual({
      kind: 'offline',
      count: 4,
      tone: 'warning',
    });
    expect(pillState('synced', { ...IDLE }, 0).kind).toBe('offline');
    expect(pillState('synced', on({ pending: 3 }), 0)).toEqual({
      kind: 'pending',
      count: 3,
      tone: 'info',
    });
    expect(pillState('synced', on({ downloading: true }), 0).kind).toBe('syncing');
    expect(pillState('synced', on({ lastSyncedAt: null }), 0).kind).toBe('syncing');
    expect(pillState('synced', on(), 0)).toEqual({ kind: 'synced', count: 0, tone: 'success' });
  });
});

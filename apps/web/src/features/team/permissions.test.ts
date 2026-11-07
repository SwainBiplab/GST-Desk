import {
  BUILTIN_ROLES,
  LAN_ROLE_PERMISSIONS,
  can,
  deriveFlags,
  permissionsOf,
  type Permissions,
} from '@gst/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LOCAL_STATE,
  fromCloud,
  getPermissions,
  pageAllowed,
  resetPermissions,
  watchCloudPermissions,
  type CloudPermissions,
} from './permissions';

import { clearActions, getActions, type ActionContext } from '@/app/actions';
import { registerDefaultActions } from '@/app/default-actions';

const ctx = (perms: Permissions): ActionContext => ({
  shell: 'books',
  businessId: 'b1',
  // every feature on, so only permissions hide anything
  flags: Object.fromEntries(
    Object.keys(deriveFlags(null)).map((k) => [k, true]),
  ) as unknown as ActionContext['flags'],
  perms,
  navigate: () => {},
  ui: {
    openCommandBar: () => {},
    openKeymap: () => {},
    toggleTheme: () => {},
    toggleDensity: () => {},
    switchShell: () => {},
    loadDemoData: async () => {},
  },
});

afterEach(() => {
  resetPermissions();
  vi.useRealTimers();
});

describe('the command bar follows the permission matrix', () => {
  it('shows each role exactly the actions the server would let it take', () => {
    clearActions();
    registerDefaultActions();
    const all = getActions();
    // every action that changes data says what it needs
    for (const a of all.filter((x) => /^(new|import|money|stock|inbox\.scan)/.test(x.id)))
      expect(a.perm, a.id).toBeDefined();
    for (const role of BUILTIN_ROLES) {
      const p = permissionsOf(role);
      const c = ctx(p);
      const shown = new Set(getActions(c).map((a) => a.id));
      for (const a of all) {
        const byRole = (!a.perm || can(p, a.perm[0], a.perm[1])) && (!a.allowed || a.allowed(p));
        expect(shown.has(a.id), `${role} ${a.id}`).toBe(byRole && (!a.when || a.when(c)));
      }
    }
  });

  it('hides purchases, settings changes and money actions from a counter, and everything that writes from a viewer', () => {
    clearActions();
    registerDefaultActions();
    const sales = new Set(getActions(ctx(permissionsOf('sales'))).map((a) => a.id));
    expect(sales.has('new.invoice')).toBe(true);
    expect(sales.has('new.purchase')).toBe(false);
    expect(sales.has('nav.migrate')).toBe(false);
    expect(sales.has('nav.reports')).toBe(false);
    const viewer = getActions(ctx(permissionsOf('viewer'))).map((a) => a.id);
    expect(viewer.filter((id) => /^(new|import|money|stock)\./.test(id))).toEqual([]);
  });

  it('opens pages by module', () => {
    expect(pageAllowed('documents', permissionsOf('inventory'))).toBe(true);
    expect(pageAllowed('gst', permissionsOf('sales'))).toBe(false);
    expect(pageAllowed('gst', permissionsOf('accountant'))).toBe(true);
    expect(pageAllowed('sell', LAN_ROLE_PERMISSIONS.view)).toBe(false);
  });
});

describe('permissions from the cloud', () => {
  const answer = (role: string, grants: Record<string, string[]> = {}): CloudPermissions => ({
    memberId: 'm1',
    permissions: { role, grants },
    policy: { approvals: true },
  });

  it('takes a built-in role from the shared table, not from the wire, and cleans a custom one', () => {
    // a tampered answer cannot widen a built-in role
    expect(fromCloud(answer('viewer', { team: ['edit'] })).perms).toEqual(permissionsOf('viewer'));
    expect(fromCloud(answer('custom', { sales: ['issue', 'fly'] })).perms.grants).toEqual({
      sales: ['view', 'issue'],
    });
    expect(fromCloud(answer('nonsense')).perms.role).toBe('viewer');
  });

  it('starts read-only, follows each answer, remembers the last one and keeps it when offline', async () => {
    vi.useFakeTimers();
    const store = new Map<string, string>();
    const storage = {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
    };
    let role = 'sales';
    let fail = false;
    const fetchPermissions = vi.fn(async () => {
      if (fail) throw new Error('offline');
      return answer(role);
    });
    const stop = watchCloudPermissions({ orgId: 'o1', fetchPermissions, storage, every: 30_000 });
    expect(getPermissions().perms.role).toBe('viewer');
    await vi.advanceTimersByTimeAsync(0);
    expect(getPermissions().perms.role).toBe('sales');
    role = 'accountant';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getPermissions().perms.role).toBe('accountant');
    fail = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getPermissions()).toMatchObject({ error: 'offline', perms: { role: 'accountant' } });
    stop();

    // a fresh start offline uses what was remembered
    const again = watchCloudPermissions({ orgId: 'o1', fetchPermissions, storage });
    expect(getPermissions().perms.role).toBe('accountant');
    again();
    expect(LOCAL_STATE.perms.role).toBe('owner');
  });
});

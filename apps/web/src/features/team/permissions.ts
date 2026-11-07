/**
 * What the person at this screen may do (prompt 42). One store, fed by where the book lives:
 * - a book on this computer only: its one user owns it (`LOCAL_OWNER`);
 * - a synced book: the cloud API's answer for this member, read again every 30 seconds so a role change
 *   holds within a minute, and remembered per organisation so the app keeps working offline;
 * - a tablet paired over the LAN: its pairing role.
 * The app hides or disables what is not allowed; the server refuses it regardless.
 */
import {
  DEFAULT_POLICY,
  LAN_ROLE_PERMISSIONS,
  LOCAL_OWNER,
  can,
  cleanGrants,
  permissionsOf,
  type Action,
  type ApprovalPolicy,
  type Module,
  type Permissions,
} from '@gst/domain';
import { useSyncExternalStore } from 'react';

export type PermissionSource = 'local' | 'cloud' | 'lan' | 'demo';

export interface PermissionState {
  perms: Permissions;
  policy: ApprovalPolicy;
  source: PermissionSource;
  memberId: string | null;
  /** When the cloud last answered (null: never, or not a cloud book). */
  checkedAt: number | null;
  /** The last failure to read them (the remembered ones stay in force). */
  error: string | null;
}

export const LOCAL_STATE: PermissionState = {
  perms: LOCAL_OWNER,
  policy: DEFAULT_POLICY,
  source: 'local',
  memberId: null,
  checkedAt: null,
  error: null,
};

let state: PermissionState = LOCAL_STATE;
const listeners = new Set<() => void>();

export const getPermissions = (): PermissionState => state;
export function setPermissions(next: Partial<PermissionState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}
export const resetPermissions = () => setPermissions(LOCAL_STATE);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function usePermissions(): PermissionState {
  return useSyncExternalStore(subscribe, getPermissions, getPermissions);
}

export function useCan(module: Module, action: Action): boolean {
  const s = usePermissions();
  return can(s.perms, module, action);
}

/** A tablet paired over the LAN acts with its pairing role. */
export function applyLanRole(role: 'full' | 'counter' | 'view'): void {
  setPermissions({ ...LOCAL_STATE, perms: LAN_ROLE_PERMISSIONS[role], source: 'lan' });
}

/** What the API answers at `/v1/orgs/:orgId/permissions`. */
export interface CloudPermissions {
  memberId: string;
  permissions: { role: string; roleName?: string; grants: Record<string, string[]> };
  policy: ApprovalPolicy;
}

/** The API's answer as the domain's type (unknown modules and actions dropped). */
export function fromCloud(
  p: CloudPermissions,
): Pick<PermissionState, 'perms' | 'policy' | 'memberId'> {
  const role = p.permissions.role;
  return {
    perms:
      role === 'custom'
        ? {
            role: 'custom',
            ...(p.permissions.roleName ? { roleName: p.permissions.roleName } : {}),
            grants: cleanGrants(p.permissions.grants),
          }
        : // a built-in role is taken from the shared table, not from what came over the wire
          permissionsOf(
            (['owner', 'admin', 'accountant', 'sales', 'inventory', 'viewer'] as const).find(
              (r) => r === role,
            ) ?? 'viewer',
          ),
    policy: { approvals: p.policy?.approvals === true },
    memberId: p.memberId,
  };
}

const KEY = (orgId: string) => `team.permissions.${orgId}`;

/** The last answer for an organisation, for working offline. */
export function remembered(
  get: (k: string) => string | null,
  orgId: string,
): CloudPermissions | null {
  try {
    const raw = get(KEY(orgId));
    return raw ? (JSON.parse(raw) as CloudPermissions) : null;
  } catch {
    return null;
  }
}

export const POLL_MS = 30_000;

/**
 * Keep the store in step with the API for a synced book. Until the first answer, the remembered one
 * applies; with neither, the book is read-only (a synced book is never assumed to be owned).
 */
export function watchCloudPermissions(o: {
  orgId: string;
  fetchPermissions: () => Promise<CloudPermissions>;
  storage: { get(k: string): string | null; set(k: string, v: string): void };
  every?: number;
  now?: () => number;
}): () => void {
  const now = o.now ?? Date.now;
  const known = remembered(o.storage.get, o.orgId);
  setPermissions({
    ...LOCAL_STATE,
    source: 'cloud',
    ...(known ? fromCloud(known) : { perms: permissionsOf('viewer') }),
  });
  let stopped = false;
  const tick = async () => {
    try {
      const p = await o.fetchPermissions();
      if (stopped) return;
      o.storage.set(KEY(o.orgId), JSON.stringify(p));
      setPermissions({ ...fromCloud(p), source: 'cloud', checkedAt: now(), error: null });
    } catch (e) {
      if (!stopped) setPermissions({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), o.every ?? POLL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Which pages a person can open at all (the nav and the command bar hide the rest). */
export function pageAllowed(page: string, p: Permissions): boolean {
  const docs = (['sales', 'notes', 'quotes', 'purchases'] as const).some((m) => can(p, m, 'view'));
  switch (page) {
    case 'sell':
      return can(p, 'sales', 'create');
    case 'parties':
      return can(p, 'parties', 'view');
    case 'items':
      return can(p, 'items', 'view');
    case 'documents':
      return docs;
    case 'payments':
      return can(p, 'payments', 'view');
    case 'reports':
      return can(p, 'reports', 'view');
    case 'gst':
    case 'einvoice':
    case 'directtax':
      return can(p, 'gst', 'view');
    case 'migrate':
      return can(p, 'settings', 'edit');
    case 'settings':
      return can(p, 'settings', 'view');
    default:
      return true;
  }
}

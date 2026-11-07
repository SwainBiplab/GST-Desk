/**
 * Shared access (prompt 47): an accountant who is not a member of an organisation but holds an active share of
 * one of its businesses. The share becomes a membership-shaped value with view-only grants, so every route and
 * permission check works unchanged, plus a `share` that narrows it to one business and one span of dates. The
 * narrowing is applied by `requireOrg` (which routes a share may use at all, and that any `businessId` named is
 * the shared one) and by the client routes (dates). Sync never sees a share: it reads memberships directly.
 */
import { DEFAULT_POLICY, type Grants, type Module, type Permissions } from '@gst/domain';

import type { Membership } from '../auth/permissions';
import type { PgDatabase } from '../db/pool';

export interface SharePerms {
  read: boolean;
  gst: boolean;
  export: boolean;
  comment: boolean;
}

export interface ShareAccess {
  id: string;
  businessId: string;
  /** ISO dates, inclusive. */
  from: string;
  to: string;
  perms: SharePerms;
  expiresAt: number | null;
}

export type Access = Membership & { share?: ShareAccess };

const READ_MODULES: Module[] = [
  'parties',
  'items',
  'inventory',
  'sales',
  'notes',
  'quotes',
  'purchases',
  'payments',
  'reports',
];

export const sharePermsOf = (v: unknown): SharePerms => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    read: o['read'] !== false,
    gst: o['gst'] === true,
    export: o['export'] === true,
    comment: o['comment'] !== false,
  };
};

/** The grants a share gives: reading (and exporting) the books, and the GST module when asked for. */
export function grantsOfShare(p: SharePerms): Grants {
  const actions = p.export ? (['view', 'export'] as const) : (['view'] as const);
  const g: Grants = {};
  if (p.read) for (const m of READ_MODULES) g[m] = [...actions];
  if (p.gst) g['gst'] = [...actions];
  return g;
}

export function permissionsOfShare(p: SharePerms): Permissions {
  return { role: 'custom', roleName: 'Shared with you', grants: grantsOfShare(p) };
}

/** The live shares of a user, across organisations: the lookup that happens before an organisation is known. */
export async function sharesOf(
  d: PgDatabase,
  userId: string,
  now: number,
  orgId?: string,
): Promise<(ShareAccess & { orgId: string; orgName: string })[]> {
  const rows =
    await d.sql`SELECT g.id, g.org_id, g.business_id, g.scope_from, g.scope_to, g.perms, g.expires_at, o.name
    FROM business_share_grants g JOIN organisations o ON o.id = g.org_id
    WHERE g.status = 'active' AND g.grantee_user_id = ${userId}
      AND (g.expires_at IS NULL OR g.expires_at > ${now})
      ${orgId ? d.sql`AND g.org_id = ${orgId}` : d.sql``}
    ORDER BY o.name, g.created_at`;
  return rows.map((r) => ({
    id: String(r['id']),
    orgId: String(r['org_id']),
    orgName: String(r['name']),
    businessId: String(r['business_id']),
    from: String(r['scope_from']),
    to: String(r['scope_to']),
    perms: sharePermsOf(r['perms']),
    expiresAt: r['expires_at'] == null ? null : Number(r['expires_at']),
  }));
}

/** Membership-shaped access through a share, or null when the user holds no live share of this organisation. */
export async function shareAccessOf(
  d: PgDatabase,
  userId: string,
  orgId: string,
  now = Date.now(),
): Promise<Access | null> {
  if (!/^[0-9a-f-]{36}$/.test(orgId)) return null;
  const [s] = await sharesOf(d, userId, now, orgId);
  if (!s) return null;
  const { orgId: _o, orgName, ...share } = s;
  return {
    id: orgId,
    name: orgName,
    memberId: `share:${share.id}`,
    role: 'viewer',
    perms: permissionsOfShare(share.perms),
    policy: DEFAULT_POLICY,
    share,
  };
}

/** Is a GST return period (MMYYYY) inside the share's dates? A period that overlaps the span counts. */
export function periodInShare(share: ShareAccess, fp: string): boolean {
  const m = fp.slice(0, 2);
  const y = fp.slice(2);
  const first = `${y}-${m}-01`;
  const last = `${y}-${m}-31`;
  return first <= share.to && last >= share.from;
}

/**
 * What a member may do (prompt 42): their built-in role from better-auth's member row, or the
 * organisation's own role recorded for them, plus the organisation's approval policy. Read on every
 * request, so a role change or a removal holds from the next request (the app re-reads its own copy every
 * 30 seconds).
 */
import {
  DEFAULT_POLICY,
  cleanGrants,
  isBuiltinRole,
  permissionsOf,
  type ApprovalPolicy,
  type BuiltinRole,
  type Permissions,
} from '@gst/domain';

import type { PgDatabase } from '../db/pool';

export interface Membership {
  /** The organisation. */
  id: string;
  name: string;
  memberId: string;
  /** The built-in role on better-auth's member row (`viewer` under a custom role). */
  role: BuiltinRole;
  perms: Permissions;
  policy: ApprovalPolicy;
}

export const builtinOf = (role: unknown): BuiltinRole => (isBuiltinRole(role) ? role : 'viewer');

/** Run with the organisation set, so row-level security applies to our own tables. */
export function inOrg<T>(
  d: PgDatabase,
  orgId: string,
  fn: (tx: PgDatabase['sql']) => Promise<T>,
): Promise<T> {
  return d.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(tx as never);
  }) as Promise<T>;
}

export async function membershipOf(
  d: PgDatabase,
  userId: string,
  orgId: string,
): Promise<Membership | null> {
  if (!/^[0-9a-f-]{36}$/.test(orgId)) return null;
  const [m] = await d.sql`SELECT m.id, m.role, o.name FROM auth_member m
    JOIN auth_organization o ON o.id = m.organization_id
    WHERE m.user_id = ${userId} AND m.organization_id = ${orgId} LIMIT 1`;
  if (!m) return null;
  const role = builtinOf(m['role']);
  const { custom, policy } = await inOrg(d, orgId, async (tx) => {
    const [c] = await tx`SELECT r.id, r.name, r.grants FROM member_roles mr
      JOIN org_roles r ON r.id = mr.role_id
      WHERE mr.member_id = ${String(m['id'])} AND r.deleted_at IS NULL`;
    const [p] = await tx`SELECT approvals FROM org_policies WHERE org_id = ${orgId}`;
    return { custom: c, policy: p };
  });
  const perms: Permissions =
    custom && role !== 'owner'
      ? { role: 'custom', roleName: String(custom['name']), grants: cleanGrants(custom['grants']) }
      : permissionsOf(role);
  return {
    id: orgId,
    name: String(m['name']),
    memberId: String(m['id']),
    role,
    perms,
    policy: p2(policy),
  };
}

const p2 = (row: Record<string, unknown> | undefined): ApprovalPolicy =>
  row ? { approvals: row['approvals'] === true } : DEFAULT_POLICY;

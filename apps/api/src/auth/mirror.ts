/**
 * Keep the shared tables in step with better-auth's: a user becomes a `users` row, an organisation an
 * `organisations` row, a member a `memberships` row with the shared role names. Membership writes set the
 * organisation for the transaction, so row-level security lets the rows in.
 */
import { newId } from '@gst/db';

import type { PgDatabase } from '../db/pool';

import type { Mirror } from './auth';
import { MEMBERSHIP_ROLE, type OrgRole } from './options';

export function mirrorInto(d: PgDatabase): Mirror {
  const q = d.sql;
  return {
    async user(u) {
      const now = Date.now();
      await q`INSERT INTO users (id, email, name, phone, locale, version, created_at, updated_at)
              VALUES (${u.id}, ${u.email ?? `${u.id}@no-email.gstdesk.invalid`}, ${u.name || 'User'}, ${u.phone}, 'en', 1, ${now}, ${now})
              ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, phone = EXCLUDED.phone, updated_at = ${now}`;
    },
    async organisation(o) {
      const now = Date.now();
      await q`INSERT INTO organisations (id, name, plan, version, created_at, updated_at)
              VALUES (${o.id}, ${o.name}, 'free', 1, ${now}, ${now})
              ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = ${now}`;
      await q.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${o.id}, true)`;
        await tx`INSERT INTO subscriptions (id, org_id, plan_id, status, started_at, created_at, updated_at)
                 VALUES (${newId()}, ${o.id}, 'free', 'active', ${now}, ${now}, ${now})
                 ON CONFLICT (org_id) DO NOTHING`;
      });
    },
    async member(m) {
      const now = Date.now();
      const role = MEMBERSHIP_ROLE[m.role as OrgRole] ?? 'viewer';
      // better-auth may add the first member before its organisation hook runs: make sure the row is there
      await q`INSERT INTO organisations (id, name, plan, version, created_at, updated_at)
              SELECT id::uuid, name, 'free', 1, ${now}, ${now} FROM auth_organization WHERE id = ${m.organizationId}
              ON CONFLICT (id) DO NOTHING`;
      await q.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${m.organizationId}, true)`;
        await tx`INSERT INTO memberships (id, org_id, user_id, business_id, role, version, created_at, updated_at, created_by, updated_by)
                 VALUES (${m.id}, ${m.organizationId}, ${m.userId}, NULL, ${role}, 1, ${now}, ${now}, ${m.userId}, ${m.userId})
                 ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, updated_at = ${now}, deleted_at = NULL`;
      });
    },
    async memberRemoved(m) {
      const now = Date.now();
      await q.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${m.organizationId}, true)`;
        await tx`UPDATE memberships SET deleted_at = ${now}, updated_at = ${now} WHERE id = ${m.id}`;
      });
    },
  };
}

export interface OrgMembership {
  id: string;
  name: string;
  role: OrgRole;
}

/**
 * The organisations a user belongs to. Read from better-auth's tables, which carry no row-level
 * security: this is the lookup that happens before any organisation is known.
 */
export async function orgsOf(d: PgDatabase, userId: string): Promise<OrgMembership[]> {
  const rows = await d.sql`SELECT m.organization_id AS id, o.name, m.role FROM auth_member m
    JOIN auth_organization o ON o.id = m.organization_id
    WHERE m.user_id = ${userId} ORDER BY o.name`;
  return rows.map((r) => ({
    id: String(r['id']),
    name: String(r['name']),
    role: String(r['role']) as OrgRole,
  }));
}

/**
 * Team (prompt 42): members, invitations, the organisation's own roles, devices, sign-in history, the
 * approval policy and approval decisions. Every change is checked against the shared matrix and against
 * `canManage`: nobody hands out more than they hold, only owners touch owners, and an organisation always
 * keeps an owner. better-auth's own organisation endpoints are closed (see `index.ts`); these are the
 * only way in.
 */
import { newId } from '@gst/db';
import {
  BUILTIN_ROLES,
  MODULES,
  ACTIONS,
  can,
  canManage,
  cleanGrants,
  grantsWithin,
  permissionsOf,
  type BuiltinRole,
  type Grants,
  type Permissions,
} from '@gst/domain';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { subApp, type App } from '../app';
import { mirrorInto } from '../auth/mirror';
import { builtinOf, inOrg, type Membership } from '../auth/permissions';
import { ApiError, errorSchema, forbidden, notFound, unauthorized } from '../errors';
import { requireOrg, requirePermission, requireSession, type OrgVars } from '../middleware/session';
import { decideApproval } from '../sync/approvals';

import type { RouteDeps } from './index';

export const INVITE_DAYS = 7;
const PHONE_EMAIL_DOMAIN = 'phone.gstdesk.invalid';
/** A phone invite is addressed to the e-mail a phone sign-in gets (`auth.ts`), so accepting it matches. */
export const phoneEmail = (phone: string) => `${phone.replace(/\D/g, '')}@${PHONE_EMAIL_DOMAIN}`;
const phoneOf = (email: string) =>
  email.endsWith(`@${PHONE_EMAIL_DOMAIN}`) ? `+${email.split('@')[0]}` : null;

const security = [{ bearer: [] }, { cookie: [] }];
const json = <T extends z.ZodTypeAny>(schema: T, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = {
  401: json(errorSchema, 'Not signed in'),
  403: json(errorSchema, 'Not allowed for this role'),
  404: json(errorSchema, 'Not found'),
  409: json(errorSchema, 'Conflicts with the current state'),
  422: json(errorSchema, 'Refused by a rule'),
};
const orgParam = z.object({
  orgId: z
    .string()
    .uuid()
    .openapi({ param: { name: 'orgId', in: 'path' } }),
});
const withId = (name: string) =>
  orgParam.extend({
    [name]: z
      .string()
      .min(1)
      .max(64)
      .openapi({ param: { name, in: 'path' } }),
  });

/** Module to actions, e.g. `{ "sales": ["view", "create"] }` (modules and actions: `@gst/domain`). */
const grantsSchema = z.record(z.string(), z.array(z.string())).openapi('Grants', {
  description: `modules: ${MODULES.join(', ')}; actions: ${ACTIONS.join(', ')}`,
});
const plain = (g: Grants) => g as Record<string, string[]>;
const permissionsSchema = z
  .object({
    role: z.string(),
    roleName: z.string().optional(),
    grants: grantsSchema,
  })
  .openapi('Permissions');
const policySchema = z.object({ approvals: z.boolean() }).openapi('ApprovalPolicy');
const roleChoice = z
  .object({
    role: z.enum(BUILTIN_ROLES).optional(),
    roleId: z.string().uuid().optional(),
  })
  .refine((v) => !!v.role !== !!v.roleId, 'Give a built-in role or a custom role, not both.');

const deviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string().nullable(),
  lastSeenAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
});
const memberSchema = z
  .object({
    memberId: z.string(),
    userId: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    role: z.enum(BUILTIN_ROLES),
    roleId: z.string().nullable(),
    roleName: z.string(),
    createdAt: z.number(),
    devices: z.array(deviceSchema),
  })
  .openapi('TeamMember');
const inviteSchema = z
  .object({
    id: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    role: z.enum(BUILTIN_ROLES),
    roleId: z.string().nullable(),
    roleName: z.string(),
    status: z.string(),
    expiresAt: z.number(),
    createdAt: z.number(),
  })
  .openapi('Invitation');
const customRoleSchema = z
  .object({ id: z.string(), name: z.string(), grants: grantsSchema, members: z.number() })
  .openapi('CustomRole');

type OrgCtx = Context<{ Variables: OrgVars }>;
const org = (c: OrgCtx) => c.get('org' as never) as Membership;
const userOf = (c: OrgCtx) => {
  const s = c.get('session');
  if (!s) throw unauthorized();
  return s.userId;
};

/** The permissions a role choice stands for (a custom role must be this organisation's). */
async function chosen(
  deps: RouteDeps,
  orgId: string,
  pick: { role?: BuiltinRole | undefined; roleId?: string | undefined },
): Promise<{ base: BuiltinRole; roleId: string | null; perms: Permissions }> {
  if (pick.role) return { base: pick.role, roleId: null, perms: permissionsOf(pick.role) };
  const [r] = await inOrg(
    deps.db,
    orgId,
    (tx) =>
      tx`SELECT id, name, grants FROM org_roles WHERE id = ${pick.roleId!} AND deleted_at IS NULL`,
  );
  if (!r) throw notFound('That role');
  return {
    base: 'viewer',
    roleId: String(r['id']),
    perms: { role: 'custom', roleName: String(r['name']), grants: cleanGrants(r['grants']) },
  };
}

/** One member's permissions, for `canManage`. */
async function targetOf(deps: RouteDeps, orgId: string, memberId: string) {
  const [m] = await deps.db
    .sql`SELECT id, user_id, role FROM auth_member WHERE id = ${memberId} AND organization_id = ${orgId}`;
  if (!m) throw notFound('That member');
  return { id: String(m['id']), userId: String(m['user_id']), role: builtinOf(m['role']) };
}

async function ownerCount(deps: RouteDeps, orgId: string): Promise<number> {
  const [r] = await deps.db
    .sql`SELECT count(*)::int AS n FROM auth_member WHERE organization_id = ${orgId} AND role = 'owner'`;
  return Number(r?.['n'] ?? 0);
}

export function teamRoutes(app: App, deps: RouteDeps): void {
  const mirror = mirrorInto(deps.db);
  const r = subApp();
  r.use('*', requireOrg as never);

  r.openapi(
    createRoute({
      method: 'get',
      path: '/permissions',
      tags: ['team'],
      summary:
        'What the caller may do here, and the approval policy (the app re-reads it every 30 s)',
      security,
      request: { params: orgParam },
      responses: {
        200: json(
          z
            .object({ memberId: z.string(), permissions: permissionsSchema, policy: policySchema })
            .openapi('MyPermissions'),
        ),
        ...errors,
      },
    }),
    (c) => {
      const o = org(c as never);
      return c.json(
        {
          memberId: o.memberId,
          permissions: { ...o.perms, grants: plain(o.perms.grants) },
          policy: o.policy,
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/team',
      tags: ['team'],
      summary: 'Members with their devices, pending invitations, custom roles and the policy',
      security,
      middleware: [requirePermission('team', 'view')] as const,
      request: { params: orgParam },
      responses: {
        200: json(
          z
            .object({
              members: z.array(memberSchema),
              invites: z.array(inviteSchema),
              roles: z.array(customRoleSchema),
              policy: policySchema,
            })
            .openapi('Team'),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const o = org(c as never);
      const members = await deps.db
        .sql`SELECT m.id, m.user_id, m.role, m.created_at, u.name, u.email,
          u.phone_number FROM auth_member m JOIN auth_user u ON u.id = m.user_id
          WHERE m.organization_id = ${o.id} ORDER BY m.created_at`;
      const invites = await deps.db.sql`SELECT id, email, role, status, expires_at, created_at
          FROM auth_invitation WHERE organization_id = ${o.id} AND status = 'pending'
          ORDER BY created_at`;
      const own = await inOrg(deps.db, o.id, async (tx) => ({
        roles: await tx`SELECT r.id, r.name, r.grants,
            (SELECT count(*)::int FROM member_roles mr WHERE mr.role_id = r.id) AS members
            FROM org_roles r WHERE r.deleted_at IS NULL ORDER BY lower(r.name)`,
        memberRoles: await tx`SELECT member_id, role_id FROM member_roles`,
        inviteRoles: await tx`SELECT invitation_id, role_id FROM invitation_roles`,
        devices:
          await tx`SELECT id, user_id, name, platform, last_seen_at, revoked_at FROM sync_devices ORDER BY created_at`,
      }));
      const roleName = new Map(own.roles.map((x) => [String(x['id']), String(x['name'])]));
      const memberRole = new Map(
        own.memberRoles.map((x) => [String(x['member_id']), String(x['role_id'])]),
      );
      const inviteRole = new Map(
        own.inviteRoles.map((x) => [String(x['invitation_id']), String(x['role_id'])]),
      );
      const num = (v: unknown) => (v == null ? null : Number(v));
      return c.json(
        {
          members: members.map((m) => {
            const roleId = memberRole.get(String(m['id'])) ?? null;
            const role = builtinOf(m['role']);
            const email = m['email'] ? String(m['email']) : null;
            return {
              memberId: String(m['id']),
              userId: String(m['user_id']),
              name: String(m['name']),
              email: email && !phoneOf(email) ? email : null,
              phone: m['phone_number'] ? String(m['phone_number']) : email ? phoneOf(email) : null,
              role,
              roleId: role === 'owner' ? null : roleId,
              roleName: (role !== 'owner' && roleId && roleName.get(roleId)) || role,
              createdAt: new Date(m['created_at'] as string).getTime(),
              devices: own.devices
                .filter((dv) => dv['user_id'] === m['user_id'])
                .map((dv) => ({
                  id: String(dv['id']),
                  name: String(dv['name']),
                  platform: dv['platform'] ? String(dv['platform']) : null,
                  lastSeenAt: num(dv['last_seen_at']),
                  revokedAt: num(dv['revoked_at']),
                })),
            };
          }),
          invites: invites.map((i) => {
            const roleId = inviteRole.get(String(i['id'])) ?? null;
            const email = String(i['email']);
            return {
              id: String(i['id']),
              email: phoneOf(email) ? null : email,
              phone: phoneOf(email),
              role: builtinOf(i['role']),
              roleId,
              roleName: (roleId && roleName.get(roleId)) || builtinOf(i['role']),
              status: String(i['status']),
              expiresAt: new Date(i['expires_at'] as string).getTime(),
              createdAt: new Date(i['created_at'] as string).getTime(),
            };
          }),
          roles: own.roles.map((x) => ({
            id: String(x['id']),
            name: String(x['name']),
            grants: plain(cleanGrants(x['grants'])),
            members: Number(x['members']),
          })),
          policy: o.policy,
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/invites',
      tags: ['team'],
      summary: 'Invite someone by e-mail or phone with a role (the accountant preset is a role)',
      security,
      middleware: [requirePermission('team', 'create')] as const,
      request: {
        params: orgParam,
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  email: z.string().trim().toLowerCase().email().max(200).optional(),
                  phone: z
                    .string()
                    .trim()
                    .regex(
                      /^\+\d{10,15}$/,
                      'a phone number with its country code, like +919876543210',
                    )
                    .optional(),
                  role: z.enum(BUILTIN_ROLES).optional(),
                  roleId: z.string().uuid().optional(),
                })
                .openapi('InviteInput'),
            },
          },
        },
      },
      responses: { 201: json(inviteSchema, 'Invited'), ...errors },
    }),
    async (c) => {
      const o = org(c as never);
      const userId = userOf(c as never);
      const b = c.req.valid('json');
      if (!!b.email === !!b.phone)
        throw new ApiError(422, 'validation', 'Give an e-mail address or a phone number.');
      if (!!b.role === !!b.roleId)
        throw new ApiError(422, 'validation', 'Choose one role for the invitation.');
      const next = await chosen(deps, o.id, b);
      if (!canManage(o.perms, null, next.perms))
        throw forbidden('You cannot invite someone with more access than you have.');
      const email = b.email ?? phoneEmail(b.phone!);
      const [already] = await deps.db
        .sql`SELECT 1 FROM auth_member m JOIN auth_user u ON u.id = m.user_id
          WHERE m.organization_id = ${o.id} AND lower(u.email) = ${email}`;
      if (already) throw new ApiError(409, 'already_member', 'They are already in the team.');
      const id = crypto.randomUUID();
      const now = Date.now();
      const expires = now + INVITE_DAYS * 86_400_000;
      await deps.db.sql.begin(async (tx) => {
        await tx`UPDATE auth_invitation SET status = 'canceled'
                 WHERE organization_id = ${o.id} AND lower(email) = ${email} AND status = 'pending'`;
        await tx`INSERT INTO auth_invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
                 VALUES (${id}, ${o.id}, ${email}, ${next.base}, 'pending', ${new Date(expires).toISOString()}::timestamptz, ${new Date(now).toISOString()}::timestamptz, ${userId})`;
        if (next.roleId) {
          await tx`SELECT set_config('app.org_id', ${o.id}, true)`;
          await tx`INSERT INTO invitation_roles (invitation_id, org_id, role_id) VALUES (${id}, ${o.id}, ${next.roleId})`;
        }
      });
      // a note to the person: they accept after signing in with that address or number
      await deps.otp
        .send({
          kind: b.phone ? 'phone' : 'email',
          to: b.phone ?? email,
          code: id,
          purpose: `invite:${o.name}`,
        })
        .catch(() => undefined);
      return c.json(
        {
          id,
          email: b.email ?? null,
          phone: b.phone ?? null,
          role: next.base,
          roleId: next.roleId,
          roleName: next.perms.roleName ?? next.base,
          status: 'pending',
          expiresAt: expires,
          createdAt: now,
        },
        201,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/invites/{inviteId}',
      tags: ['team'],
      summary: 'Withdraw a pending invitation',
      security,
      middleware: [requirePermission('team', 'create')] as const,
      request: { params: withId('inviteId') },
      responses: { 204: { description: 'Withdrawn' }, ...errors },
    }),
    async (c) => {
      const o = org(c as never);
      const { inviteId } = c.req.valid('param') as { inviteId: string };
      const rows = await deps.db
        .sql`UPDATE auth_invitation SET status = 'canceled' WHERE id = ${inviteId} AND organization_id = ${o.id} AND status = 'pending' RETURNING id`;
      if (!rows.length) throw notFound('That invitation');
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/members/{memberId}',
      tags: ['team'],
      summary: 'Change a member’s role',
      security,
      middleware: [requirePermission('team', 'edit')] as const,
      request: {
        params: withId('memberId'),
        body: { content: { 'application/json': { schema: roleChoice.openapi('RoleChoice') } } },
      },
      responses: { 204: { description: 'Changed' }, ...errors },
    }),
    async (c) => {
      const o = org(c as never);
      const { memberId } = c.req.valid('param') as { memberId: string };
      const target = await targetOf(deps, o.id, memberId);
      const next = await chosen(deps, o.id, c.req.valid('json'));
      if (!canManage(o.perms, target, next.perms))
        throw forbidden('You cannot give this role, or change this member.');
      if (target.role === 'owner' && next.base !== 'owner' && (await ownerCount(deps, o.id)) < 2)
        throw new ApiError(
          409,
          'last_owner',
          'An organisation needs an owner. Make someone else owner first.',
        );
      await deps.db.sql.begin(async (tx) => {
        await tx`UPDATE auth_member SET role = ${next.base} WHERE id = ${memberId}`;
        await tx`SELECT set_config('app.org_id', ${o.id}, true)`;
        await tx`DELETE FROM member_roles WHERE member_id = ${memberId}`;
        if (next.roleId)
          await tx`INSERT INTO member_roles (member_id, org_id, role_id, updated_at) VALUES (${memberId}, ${o.id}, ${next.roleId}, ${Date.now()})`;
      });
      await mirror.member({
        id: memberId,
        organizationId: o.id,
        userId: target.userId,
        role: next.base,
      });
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/members/{memberId}',
      tags: ['team'],
      summary: 'Remove a member (or leave): their devices stop syncing',
      security,
      request: { params: withId('memberId') },
      responses: { 204: { description: 'Removed' }, ...errors },
    }),
    async (c) => {
      const o = org(c as never);
      const userId = userOf(c as never);
      const { memberId } = c.req.valid('param') as { memberId: string };
      const target = await targetOf(deps, o.id, memberId);
      const leaving = target.userId === userId;
      if (!leaving && !canManage(o.perms, target, null))
        throw forbidden('You cannot remove this member.');
      if (target.role === 'owner' && (await ownerCount(deps, o.id)) < 2)
        throw new ApiError(
          409,
          'last_owner',
          'An organisation needs an owner. Make someone else owner first.',
        );
      const now = Date.now();
      await deps.db.sql.begin(async (tx) => {
        await tx`DELETE FROM auth_member WHERE id = ${memberId}`;
        await tx`SELECT set_config('app.org_id', ${o.id}, true)`;
        await tx`DELETE FROM member_roles WHERE member_id = ${memberId}`;
        await tx`UPDATE sync_devices SET revoked_at = ${now} WHERE user_id = ${target.userId} AND revoked_at IS NULL`;
      });
      await mirror.memberRemoved({ id: memberId, organizationId: o.id });
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/devices/{deviceId}/revoke',
      tags: ['team'],
      summary: 'Stop a device syncing (your own, or anyone’s with team rights)',
      security,
      request: { params: withId('deviceId') },
      responses: { 204: { description: 'Revoked' }, ...errors },
    }),
    async (c) => {
      const o = org(c as never);
      const userId = userOf(c as never);
      const { deviceId } = c.req.valid('param') as { deviceId: string };
      if (!/^[0-9a-f-]{36}$/.test(deviceId)) throw notFound('That device');
      const done = await inOrg(deps.db, o.id, async (tx) => {
        const [dv] = await tx`SELECT user_id FROM sync_devices WHERE id = ${deviceId}`;
        if (!dv) throw notFound('That device');
        const owner = String(dv['user_id']);
        if (owner !== userId) {
          if (!can(o.perms, 'team', 'edit')) throw forbidden('You cannot remove this device.');
          const [m] = await deps.db
            .sql`SELECT role FROM auth_member WHERE organization_id = ${o.id} AND user_id = ${owner}`;
          if (m && builtinOf(m['role']) === 'owner' && o.perms.role !== 'owner')
            throw forbidden('Only an owner can remove an owner’s device.');
        }
        return tx`UPDATE sync_devices SET revoked_at = ${Date.now()} WHERE id = ${deviceId} AND revoked_at IS NULL RETURNING id`;
      });
      void done;
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/members/{memberId}/sign-ins',
      tags: ['team'],
      summary: 'Recent sign-ins of a member (your own, or anyone’s with audit rights)',
      security,
      request: { params: withId('memberId') },
      responses: {
        200: json(
          z.array(
            z
              .object({
                at: z.number(),
                expiresAt: z.number(),
                ip: z.string().nullable(),
                userAgent: z.string().nullable(),
                current: z.boolean(),
              })
              .openapi('SignIn'),
          ),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const o = org(c as never);
      const userId = userOf(c as never);
      const { memberId } = c.req.valid('param') as { memberId: string };
      const target = await targetOf(deps, o.id, memberId);
      if (target.userId !== userId && !can(o.perms, 'audit', 'view'))
        throw forbidden('You can see your own sign-ins only.');
      const current = c.get('session')?.sessionId;
      const rows = await deps.db.sql`SELECT id, created_at, expires_at, ip_address, user_agent
          FROM auth_session WHERE user_id = ${target.userId} ORDER BY created_at DESC LIMIT 50`;
      return c.json(
        rows.map((s) => ({
          at: new Date(s['created_at'] as string).getTime(),
          expiresAt: new Date(s['expires_at'] as string).getTime(),
          ip: s['ip_address'] ? String(s['ip_address']) : null,
          userAgent: s['user_agent'] ? String(s['user_agent']) : null,
          current: s['id'] === current,
        })),
        200,
      );
    },
  );

  const roleInput = z
    .object({
      name: z.string().trim().min(1).max(60),
      grants: z.record(z.string(), z.array(z.string())),
    })
    .openapi('CustomRoleInput');

  r.openapi(
    createRoute({
      method: 'post',
      path: '/roles',
      tags: ['team'],
      summary: 'Make a role of the organisation’s own',
      security,
      middleware: [requirePermission('team', 'edit')] as const,
      request: {
        params: orgParam,
        body: { content: { 'application/json': { schema: roleInput } } },
      },
      responses: { 201: json(customRoleSchema, 'Made'), ...errors },
    }),
    async (c) => {
      const o = org(c as never);
      const b = c.req.valid('json');
      const grants = cleanGrants(b.grants);
      if (!grantsWithin(grants, o.perms.grants))
        throw forbidden('A role cannot hold more than you have.');
      if ((BUILTIN_ROLES as readonly string[]).includes(b.name.toLowerCase()))
        throw new ApiError(409, 'name_taken', 'That name is a built-in role.');
      const id = newId();
      const now = Date.now();
      try {
        await inOrg(
          deps.db,
          o.id,
          (tx) =>
            tx`INSERT INTO org_roles (id, org_id, name, grants, created_at, updated_at) VALUES (${id}, ${o.id}, ${b.name}, ${JSON.stringify(grants)}::jsonb, ${now}, ${now})`,
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ApiError(409, 'name_taken', 'There is already a role with that name.');
        throw e;
      }
      return c.json({ id, name: b.name, grants: plain(grants), members: 0 }, 201);
    },
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/roles/{roleId}',
      tags: ['team'],
      summary: 'Change a custom role (its members have the new grants from their next request)',
      security,
      middleware: [requirePermission('team', 'edit')] as const,
      request: {
        params: withId('roleId'),
        body: { content: { 'application/json': { schema: roleInput } } },
      },
      responses: { 204: { description: 'Changed' }, ...errors },
    }),
    async (c) => {
      const o = org(c as never);
      const { roleId } = c.req.valid('param') as { roleId: string };
      const b = c.req.valid('json');
      const grants = cleanGrants(b.grants);
      if (!grantsWithin(grants, o.perms.grants))
        throw forbidden('A role cannot hold more than you have.');
      if (!/^[0-9a-f-]{36}$/.test(roleId)) throw notFound('That role');
      const rows = await inOrg(
        deps.db,
        o.id,
        (tx) =>
          tx`UPDATE org_roles SET name = ${b.name}, grants = ${JSON.stringify(grants)}::jsonb, updated_at = ${Date.now()} WHERE id = ${roleId} AND deleted_at IS NULL RETURNING id`,
      );
      if (!rows.length) throw notFound('That role');
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/roles/{roleId}',
      tags: ['team'],
      summary: 'Remove a custom role nobody holds',
      security,
      middleware: [requirePermission('team', 'edit')] as const,
      request: { params: withId('roleId') },
      responses: { 204: { description: 'Removed' }, ...errors },
    }),
    async (c) => {
      const o = org(c as never);
      const { roleId } = c.req.valid('param') as { roleId: string };
      if (!/^[0-9a-f-]{36}$/.test(roleId)) throw notFound('That role');
      await inOrg(deps.db, o.id, async (tx) => {
        const [used] = await tx`SELECT 1 FROM member_roles WHERE role_id = ${roleId}
          UNION ALL SELECT 1 FROM invitation_roles ir JOIN auth_invitation i ON i.id = ir.invitation_id
          WHERE ir.role_id = ${roleId} AND i.status = 'pending' LIMIT 1`;
        if (used)
          throw new ApiError(
            409,
            'in_use',
            'Someone holds this role. Give them another role first.',
          );
        const rows =
          await tx`UPDATE org_roles SET deleted_at = ${Date.now()} WHERE id = ${roleId} AND deleted_at IS NULL RETURNING id`;
        if (!rows.length) throw notFound('That role');
      });
      return c.body(null, 204);
    },
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/policy',
      tags: ['team'],
      summary: 'Turn approvals on or off (owners only)',
      security,
      request: {
        params: orgParam,
        body: { content: { 'application/json': { schema: policySchema } } },
      },
      responses: { 200: json(policySchema), ...errors },
    }),
    async (c) => {
      const o = org(c as never);
      if (o.perms.role !== 'owner') throw forbidden('Only an owner can change the approval rules.');
      const b = c.req.valid('json');
      const by = userOf(c as never);
      await inOrg(
        deps.db,
        o.id,
        (tx) => tx`INSERT INTO org_policies (org_id, approvals, updated_at, updated_by)
          VALUES (${o.id}, ${b.approvals}, ${Date.now()}, ${by})
          ON CONFLICT (org_id) DO UPDATE SET approvals = EXCLUDED.approvals, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      );
      return c.json({ approvals: b.approvals }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/approvals/{itemId}',
      tags: ['team'],
      summary: 'Approve or decline a held cancellation or revision',
      security,
      request: {
        params: withId('itemId'),
        body: {
          content: {
            'application/json': {
              schema: z
                .object({
                  decision: z.enum(['approve', 'decline']),
                  note: z.string().trim().max(300).optional(),
                })
                .openapi('ApprovalDecision'),
            },
          },
        },
      },
      responses: {
        200: json(
          z
            .object({
              outcome: z.enum(['approved', 'declined', 'conflict', 'refused']),
              reason: z.string().optional(),
              reviewItemId: z.string().optional(),
            })
            .openapi('ApprovalResult'),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const o = org(c as never);
      const { itemId } = c.req.valid('param') as { itemId: string };
      if (!/^[0-9a-f-]{36}$/.test(itemId)) throw notFound('That approval request');
      const b = c.req.valid('json');
      const result = await decideApproval(
        deps.db,
        { ...o, userId: userOf(c as never) },
        itemId,
        b.decision,
        b.note,
      );
      return c.json(result, 200);
    },
  );

  app.route('/v1/orgs/:orgId', r as never);

  // the invited person: their pending invitations, accept and decline
  const mine = async (userId: string) => {
    const [u] = await deps.db.sql`SELECT email FROM auth_user WHERE id = ${userId}`;
    return String(u?.['email'] ?? '').toLowerCase();
  };

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me/invites',
      tags: ['team'],
      summary: 'Invitations waiting for the caller',
      security,
      middleware: [requireSession] as const,
      responses: {
        200: json(
          z.array(
            z
              .object({
                id: z.string(),
                orgId: z.string(),
                orgName: z.string(),
                roleName: z.string(),
                invitedBy: z.string(),
                expiresAt: z.number(),
              })
              .openapi('MyInvite'),
          ),
        ),
        401: errors[401],
      },
    }),
    async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      const email = await mine(s.userId);
      const rows = await deps.db
        .sql`SELECT i.id, i.organization_id, i.role, i.expires_at, o.name, u.name AS by
          FROM auth_invitation i JOIN auth_organization o ON o.id = i.organization_id
          JOIN auth_user u ON u.id = i.inviter_id
          WHERE lower(i.email) = ${email} AND i.status = 'pending' AND i.expires_at > now()
          ORDER BY i.created_at`;
      const out = [];
      for (const i of rows) {
        const orgId = String(i['organization_id']);
        const [cr] = await inOrg(
          deps.db,
          orgId,
          (tx) => tx`SELECT r.name FROM invitation_roles ir
            JOIN org_roles r ON r.id = ir.role_id WHERE ir.invitation_id = ${String(i['id'])}`,
        );
        out.push({
          id: String(i['id']),
          orgId,
          orgName: String(i['name']),
          roleName: cr ? String(cr['name']) : builtinOf(i['role']),
          invitedBy: String(i['by']),
          expiresAt: new Date(i['expires_at'] as string).getTime(),
        });
      }
      return c.json(out, 200);
    },
  );

  const decide = (accept: boolean) =>
    createRoute({
      method: 'post',
      path: `/v1/invites/{inviteId}/${accept ? 'accept' : 'decline'}`,
      tags: ['team'],
      summary: accept ? 'Join the organisation that invited you' : 'Turn an invitation down',
      security,
      middleware: [requireSession] as const,
      request: {
        params: z.object({
          inviteId: z
            .string()
            .min(1)
            .max(64)
            .openapi({ param: { name: 'inviteId', in: 'path' } }),
        }),
      },
      responses: {
        200: json(z.object({ orgId: z.string() }).openapi('InviteAccepted')),
        ...errors,
      },
    });

  for (const accept of [true, false]) {
    app.openapi(decide(accept), async (c) => {
      const s = c.get('session');
      if (!s) throw unauthorized();
      const { inviteId } = c.req.valid('param');
      const email = await mine(s.userId);
      const [inv] = await deps.db.sql`SELECT id, organization_id, role, status, expires_at
          FROM auth_invitation WHERE id = ${inviteId} AND lower(email) = ${email}`;
      // someone else's invitation is "not found", so ids cannot be probed
      if (!inv || inv['status'] !== 'pending') throw notFound('That invitation');
      if (new Date(inv['expires_at'] as string).getTime() < Date.now())
        throw new ApiError(410, 'expired', 'That invitation has expired. Ask for a new one.');
      const orgId = String(inv['organization_id']);
      if (!accept) {
        await deps.db.sql`UPDATE auth_invitation SET status = 'rejected' WHERE id = ${inviteId}`;
        return c.json({ orgId }, 200);
      }
      const role = builtinOf(inv['role']);
      const memberId = crypto.randomUUID();
      await deps.db.sql.begin(async (tx) => {
        const [already] =
          await tx`SELECT id FROM auth_member WHERE organization_id = ${orgId} AND user_id = ${s.userId}`;
        if (already) throw new ApiError(409, 'already_member', 'You are already in this team.');
        await tx`INSERT INTO auth_member (id, organization_id, user_id, role, created_at) VALUES (${memberId}, ${orgId}, ${s.userId}, ${role}, now())`;
        await tx`UPDATE auth_invitation SET status = 'accepted' WHERE id = ${inviteId}`;
        await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
        const [ir] =
          await tx`SELECT role_id FROM invitation_roles WHERE invitation_id = ${inviteId}`;
        if (ir)
          await tx`INSERT INTO member_roles (member_id, org_id, role_id, updated_at) VALUES (${memberId}, ${orgId}, ${String(ir['role_id'])}, ${Date.now()})`;
      });
      await mirror.member({ id: memberId, organizationId: orgId, userId: s.userId, role });
      return c.json({ orgId }, 200);
    });
  }
}

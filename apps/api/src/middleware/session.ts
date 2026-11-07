/**
 * Who is calling: better-auth reads the session cookie or the bearer token. Routes under an organisation
 * then check that the caller is a member and set the repository context, so every query runs with
 * `app.org_id` and row-level security. The organisation limiter counts here too.
 */
import type { Ctx } from '@gst/db';
import { can as allows, canWriteAnything, type Action, type Module } from '@gst/domain';
import type { Context, MiddlewareHandler } from 'hono';

import { type Vars } from '../app';
import { membershipOf } from '../auth/permissions';
import { ApiError, forbidden, notFound, unauthorized } from '../errors';
import { periodInShare, shareAccessOf, type Access, type ShareAccess } from '../portals/access';

export interface OrgVars extends Vars {
  org: Access;
  ctx: Ctx;
}

/** A share covers one business and one span of dates: refuse a call that names another, or another route. */
async function narrowToShare(
  c: Context<{ Variables: OrgVars }>,
  share: ShareAccess,
  orgId: string,
): Promise<void> {
  const path = c.req.path.replace(`/v1/orgs/${orgId}`, '');
  const allowed = SHARE_ROUTES.some(
    (r) => (r.method === '*' || r.method === c.req.method) && r.re.test(path),
  );
  if (!allowed) throw forbidden('A shared business can only be read.');
  const named = new Set<string>();
  const q = c.req.query('businessId');
  if (q) named.add(q);
  const inPath = /^\/businesses\/([^/]+)$/.exec(path)?.[1];
  if (inPath) named.add(inPath);
  if (c.req.header('content-type')?.includes('application/json')) {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (body && typeof body['businessId'] === 'string') named.add(body['businessId']);
  }
  for (const b of named) if (b !== share.businessId) throw notFound('That business');
  const period = c.req.query('period');
  if (period && !periodInShare(share, period))
    throw forbidden('That period is outside what was shared with you.');
}

/** Resolve the session (or none). Never throws: public routes read `session` as null. */
export const readSession: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  const auth = c.get('deps').auth;
  const s = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set(
    'session',
    s
      ? {
          userId: s.user.id,
          sessionId: s.session.id,
          activeOrganizationId:
            (s.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
        }
      : null,
  );
  await next();
};

export const requireSession: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  if (!c.get('session')) throw unauthorized();
  await next();
};

/**
 * What an accountant holding a share (prompt 47) may call under the organisation: reading the client, the
 * filing desk's figures and files, and the permission and business lookups the app makes. Everything else is
 * refused before the route runs, whatever its own permission check would say.
 */
const SHARE_ROUTES: { method: string; re: RegExp }[] = [
  { method: 'GET', re: /^\/businesses(\/[^/]+)?$/ },
  { method: 'GET', re: /^\/permissions$/ },
  { method: '*', re: /^\/client(\/|$)/ },
  { method: 'GET', re: /^\/filing\/(status|desk|pack|jobs)$/ },
];

/** Membership of the organisation in the path, then the repository context for it. */
export const requireOrg: MiddlewareHandler<{ Variables: OrgVars }> = async (c, next) => {
  const session = c.get('session');
  if (!session) throw unauthorized();
  const orgId = c.req.param('orgId');
  if (!orgId || !/^[0-9a-f-]{36}$/.test(orgId)) throw notFound('That organisation');
  const deps = c.get('deps');
  const org: Access | null =
    (await membershipOf(deps.db, session.userId, orgId)) ??
    (await shareAccessOf(deps.db, session.userId, orgId));
  if (!org) throw notFound('That organisation');
  if (org.share) await narrowToShare(c, org.share, orgId);
  const r = await deps.orgLimiter.take(`org:${orgId}`);
  if (!r.ok)
    throw new ApiError(
      429,
      'rate_limited',
      'This organisation is making too many requests. Try again shortly.',
    );
  c.set('org', org);
  c.set('ctx', { orgId, businessId: '', actor: session.userId, deviceId: 'api' });
  await next();
};

/** Does the caller's role allow this, by the shared permission matrix (`@gst/domain`). */
export function can(c: Context<{ Variables: OrgVars }>, module: Module, action: Action): boolean {
  return allows(c.get('org').perms, module, action);
}

const roleLabel = (c: Context<{ Variables: OrgVars }>) => {
  const p = c.get('org').perms;
  return p.roleName ?? p.role;
};

export function requirePermission(
  module: Module,
  action: Action,
): MiddlewareHandler<{ Variables: OrgVars }> {
  return async (c, next) => {
    if (!can(c, module, action))
      throw forbidden(`Your role (${roleLabel(c)}) cannot ${action} ${module}.`);
    await next();
  };
}

/** Anything that writes: everyone but a role that only views. */
export const requireWriter: MiddlewareHandler<{ Variables: OrgVars }> = async (c, next) => {
  if (!canWriteAnything(c.get('org').perms))
    throw forbidden(`Your role (${roleLabel(c)}) can only view.`);
  await next();
};

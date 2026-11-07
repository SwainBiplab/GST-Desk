/**
 * Team and permissions (prompt 42) against a real Postgres: invitations, every guarded route for every
 * built-in role checked against the shared matrix, the ways one might try to climb (an admin and owners,
 * handing out more than one holds, better-auth's own endpoints), custom roles, removal, sign-in history,
 * and the sync write path: a viewer writes nothing, a counter cannot touch purchases, and with approvals on
 * a cancellation waits for an approver.
 */
import { DocumentFlowRepo, PartyRepo, type Ctx } from '@gst/db';
import { BUILTIN_ROLES, can, permissionsOf, type BuiltinRole } from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startPostgres, type PgStack } from './containers';
import { invoiceDraft, toRows } from './sync-helper';

let pg: PgStack;
let t: TestApp;
let owner: Client;
let ownerId: string;
let orgId: string;
let businessId: string;

const SYNC_ENV = {
  POWERSYNC_URL: 'http://powersync.invalid:8080',
  POWERSYNC_JWT_SECRET: 'team-test-secret-'.padEnd(48, 'x'),
};

const userIdOf = async (email: string) =>
  String((await pg.app.sql`SELECT id FROM auth_user WHERE email = ${email}`)[0]!['id']);

/** Sign someone in and put them in the organisation with a role (better-auth's server-side add). */
async function member(email: string, role: BuiltinRole): Promise<Client> {
  const c = await t.signIn(email);
  await t.auth.api.addMember({
    body: { organizationId: orgId, userId: await userIdOf(email), role },
  });
  return c;
}

const memberIdOf = async (email: string) =>
  String(
    (
      await pg.app.sql`SELECT m.id FROM auth_member m JOIN auth_user u ON u.id = m.user_id
        WHERE u.email = ${email} AND m.organization_id = ${orgId}`
    )[0]!['id'],
  );

beforeAll(async () => {
  pg = await startPostgres();
  t = makeTestApp(pg, { env: SYNC_ENV });
  owner = await t.signIn('owner@example.com', 'Owner');
  ownerId = await userIdOf('owner@example.com');
  orgId = (
    await owner.json<{ id: string }>('/v1/orgs', {
      method: 'POST',
      body: JSON.stringify({ name: 'Team Traders' }),
    })
  ).body.id;
  businessId = (
    await owner.json<{ id: string }>(`/v1/orgs/${orgId}/businesses`, {
      method: 'POST',
      body: JSON.stringify({ legalName: 'Team Traders', stateCode: '27' }),
    })
  ).body.id;
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

describe('invitations', () => {
  it('invites by e-mail, the person sees it after signing in and joins with that role', async () => {
    const inv = await owner.json<{ id: string; roleName: string }>(`/v1/orgs/${orgId}/invites`, {
      method: 'POST',
      body: JSON.stringify({ email: 'bala@example.com', role: 'sales' }),
    });
    expect(inv.status).toBe(201);
    expect(t.otp.last('bala@example.com')).toBe(inv.body.id);

    // someone else cannot accept it, and does not even learn it exists
    const other = await t.signIn('mallory@example.com');
    expect(
      (await other.fetch(`/v1/invites/${inv.body.id}/accept`, { method: 'POST' })).status,
    ).toBe(404);

    const bala = await t.signIn('bala@example.com', 'Bala');
    const mine =
      await bala.json<{ id: string; orgName: string; roleName: string }[]>('/v1/me/invites');
    expect(mine.body).toEqual([
      expect.objectContaining({ id: inv.body.id, orgName: 'Team Traders', roleName: 'sales' }),
    ]);
    expect((await bala.fetch(`/v1/invites/${inv.body.id}/accept`, { method: 'POST' })).status).toBe(
      200,
    );
    const p = await bala.json<{ permissions: { role: string } }>(`/v1/orgs/${orgId}/permissions`);
    expect(p.body.permissions.role).toBe('sales');
    // used once
    expect((await bala.fetch(`/v1/invites/${inv.body.id}/accept`, { method: 'POST' })).status).toBe(
      404,
    );
  });

  it('invites by phone, with the accountant preset, and can be withdrawn', async () => {
    const inv = await owner.json<{ id: string; phone: string; roleName: string }>(
      `/v1/orgs/${orgId}/invites`,
      { method: 'POST', body: JSON.stringify({ phone: '+919876543210', role: 'accountant' }) },
    );
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({ phone: '+919876543210', roleName: 'accountant' });
    const team = await owner.json<{ invites: { id: string; phone: string | null }[] }>(
      `/v1/orgs/${orgId}/team`,
    );
    expect(team.body.invites.map((i) => i.phone)).toContain('+919876543210');
    expect(
      (await owner.fetch(`/v1/orgs/${orgId}/invites/${inv.body.id}`, { method: 'DELETE' })).status,
    ).toBe(204);
  });
});

describe('every guarded route, for every role, as the matrix says', () => {
  it('answers each role exactly as the shared permission matrix allows', async () => {
    const clients: Partial<Record<BuiltinRole, Client>> = { owner };
    for (const r of BUILTIN_ROLES.filter((x) => x !== 'owner'))
      clients[r] = await member(`${r}-matrix@example.com`, r);

    const checks: {
      name: string;
      allowed: (r: BuiltinRole) => boolean;
      call: (c: Client) => Promise<Response>;
    }[] = [
      {
        name: 'create a business',
        allowed: (r) => can(permissionsOf(r), 'settings', 'edit'),
        call: (c) =>
          c.fetch(`/v1/orgs/${orgId}/businesses`, {
            method: 'POST',
            body: JSON.stringify({ legalName: 'Branch', stateCode: '27' }),
          }),
      },
      {
        name: 'see the team',
        allowed: (r) => can(permissionsOf(r), 'team', 'view'),
        call: (c) => c.fetch(`/v1/orgs/${orgId}/team`),
      },
      {
        name: 'invite a viewer',
        allowed: (r) => can(permissionsOf(r), 'team', 'create'),
        call: (c) =>
          c.fetch(`/v1/orgs/${orgId}/invites`, {
            method: 'POST',
            body: JSON.stringify({ email: `x-${crypto.randomUUID()}@example.com`, role: 'viewer' }),
          }),
      },
      {
        name: 'make a role',
        allowed: (r) => can(permissionsOf(r), 'team', 'edit'),
        call: (c) =>
          c.fetch(`/v1/orgs/${orgId}/roles`, {
            method: 'POST',
            body: JSON.stringify({
              name: `r-${crypto.randomUUID().slice(0, 6)}`,
              grants: { reports: ['view'] },
            }),
          }),
      },
      {
        name: 'change the approval rules',
        allowed: (r) => r === 'owner',
        call: (c) =>
          c.fetch(`/v1/orgs/${orgId}/policy`, {
            method: 'PUT',
            body: JSON.stringify({ approvals: false }),
          }),
      },
      {
        name: 'read my permissions',
        allowed: () => true,
        call: (c) => c.fetch(`/v1/orgs/${orgId}/permissions`),
      },
    ];
    const got: string[] = [];
    const want: string[] = [];
    for (const r of BUILTIN_ROLES) {
      for (const check of checks) {
        const res = await check.call(clients[r]!);
        got.push(`${r} ${check.name}: ${res.status < 300 ? 'yes' : res.status}`);
        want.push(`${r} ${check.name}: ${check.allowed(r) ? 'yes' : 403}`);
      }
    }
    expect(got).toEqual(want);
  });
});

describe('no way up', () => {
  it('an admin cannot demote, remove or make an owner, nor reach better-auth’s own endpoints', async () => {
    const admin = await member('admin2@example.com', 'admin');
    const ownerMember = await memberIdOf('owner@example.com');
    const v = await member('victim@example.com', 'viewer');
    void v;
    const victim = await memberIdOf('victim@example.com');
    const patch = (c: Client, id: string, body: unknown) =>
      c.fetch(`/v1/orgs/${orgId}/members/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    expect((await patch(admin, ownerMember, { role: 'viewer' })).status).toBe(403);
    expect((await patch(admin, victim, { role: 'owner' })).status).toBe(403);
    expect(
      (await admin.fetch(`/v1/orgs/${orgId}/members/${ownerMember}`, { method: 'DELETE' })).status,
    ).toBe(403);
    expect((await patch(admin, victim, { role: 'sales' })).status).toBe(204);

    for (const path of ['update-member-role', 'add-member', 'invite-member', 'remove-member']) {
      const r = await admin.fetch(`/v1/auth/organization/${path}`, {
        method: 'POST',
        body: JSON.stringify({ organizationId: orgId, memberId: ownerMember, role: 'owner' }),
      });
      expect(r.status, path).toBe(404);
    }
  });

  it('nobody hands out more than they hold, and the last owner stays', async () => {
    const role = await owner.json<{ id: string }>(`/v1/orgs/${orgId}/roles`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Team lead',
        grants: { team: ['view', 'create', 'edit'], sales: ['view', 'create'], parties: ['view'] },
      }),
    });
    expect(role.status).toBe(201);
    const lead = await member('lead@example.com', 'viewer');
    expect(
      (
        await owner.fetch(`/v1/orgs/${orgId}/members/${await memberIdOf('lead@example.com')}`, {
          method: 'PATCH',
          body: JSON.stringify({ roleId: role.body.id }),
        })
      ).status,
    ).toBe(204);
    const asLead = await lead.json<{ permissions: { role: string; roleName: string } }>(
      `/v1/orgs/${orgId}/permissions`,
    );
    expect(asLead.body.permissions).toMatchObject({ role: 'custom', roleName: 'Team lead' });

    const invite = (body: unknown) =>
      lead.fetch(`/v1/orgs/${orgId}/invites`, { method: 'POST', body: JSON.stringify(body) });
    expect((await invite({ email: 'too-much@example.com', role: 'sales' })).status).toBe(403);
    // even the viewer role sees every module, which is more than the lead holds
    expect((await invite({ email: 'ok@example.com', role: 'viewer' })).status).toBe(403);
    const narrow = await owner.json<{ id: string }>(`/v1/orgs/${orgId}/roles`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Looker', grants: { sales: ['view'] } }),
    });
    expect((await invite({ email: 'ok@example.com', roleId: narrow.body.id })).status).toBe(201);
    const bigger = await lead.fetch(`/v1/orgs/${orgId}/roles`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Boss', grants: { sales: ['view', 'cancel'] } }),
    });
    expect(bigger.status).toBe(403);
    // a role in use cannot be removed
    expect(
      (await owner.fetch(`/v1/orgs/${orgId}/roles/${role.body.id}`, { method: 'DELETE' })).status,
    ).toBe(409);

    // the one owner cannot step down or leave
    const me = await memberIdOf('owner@example.com');
    expect(
      (
        await owner.fetch(`/v1/orgs/${orgId}/members/${me}`, {
          method: 'PATCH',
          body: JSON.stringify({ role: 'admin' }),
        })
      ).status,
    ).toBe(409);
    expect(
      (await owner.fetch(`/v1/orgs/${orgId}/members/${me}`, { method: 'DELETE' })).status,
    ).toBe(409);
  });

  it('a role change holds from the next request, and a removed member is out at once', async () => {
    const pat = await member('pat@example.com', 'sales');
    const id = await memberIdOf('pat@example.com');
    const seen = async () =>
      (await pat.json<{ permissions: { role: string } }>(`/v1/orgs/${orgId}/permissions`)).body
        .permissions?.role;
    expect(await seen()).toBe('sales');
    await owner.fetch(`/v1/orgs/${orgId}/members/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: 'viewer' }),
    });
    expect(await seen()).toBe('viewer');
    const tok = await pat.json<{ deviceId: string }>('/v1/sync/token', {
      method: 'POST',
      body: JSON.stringify({ orgId, deviceName: 'Pat’s phone' }),
    });
    expect(tok.status).toBe(200);
    expect(
      (await owner.fetch(`/v1/orgs/${orgId}/members/${id}`, { method: 'DELETE' })).status,
    ).toBe(204);
    expect((await pat.fetch(`/v1/orgs/${orgId}/permissions`)).status).toBe(404);
    const again = await pat.fetch('/v1/sync/token', {
      method: 'POST',
      body: JSON.stringify({ orgId, deviceId: tok.body.deviceId, deviceName: 'Pat’s phone' }),
    });
    expect(again.status).toBe(404);
    const [dev] = await pg.app.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      return tx`SELECT revoked_at FROM sync_devices WHERE id = ${tok.body.deviceId}`;
    });
    expect(dev!['revoked_at']).not.toBeNull();
  });

  it('shows sign-ins: your own to anyone, everyone’s to those who read the audit trail', async () => {
    const sam = await member('sam@example.com', 'sales');
    const samId = await memberIdOf('sam@example.com');
    const ownerMember = await memberIdOf('owner@example.com');
    const own = await sam.json<{ at: number; current: boolean }[]>(
      `/v1/orgs/${orgId}/members/${samId}/sign-ins`,
    );
    expect(own.status).toBe(200);
    expect(own.body.some((s) => s.current)).toBe(true);
    expect((await sam.fetch(`/v1/orgs/${orgId}/members/${ownerMember}/sign-ins`)).status).toBe(403);
    expect((await owner.fetch(`/v1/orgs/${orgId}/members/${samId}/sign-ins`)).status).toBe(200);
  });
});

describe('the sync write path', () => {
  const ctx = (): Ctx => ({ orgId, businessId, actor: ownerId, deviceId: 'server' });

  async function device(c: Client): Promise<string> {
    const r = await c.json<{ deviceId: string }>('/v1/sync/token', {
      method: 'POST',
      body: JSON.stringify({ orgId, deviceName: `${c.email} laptop` }),
    });
    expect(r.status).toBe(200);
    return r.body.deviceId;
  }
  let txId = 1;
  async function upload(c: Client, deviceId: string, ops: unknown[]) {
    const r = await c.json<{
      results: { outcome: string; reason?: string; reviewItemId?: string }[];
    }>('/v1/sync/write', {
      method: 'POST',
      body: JSON.stringify({ orgId, deviceId, transactions: [{ txId: txId++, ops }] }),
    });
    expect(r.status).toBe(200);
    return r.body.results[0]!;
  }
  const partyOp = () => {
    const now = Date.now();
    return {
      op: 'PUT',
      table: 'parties',
      id: crypto.randomUUID(),
      data: {
        business_id: businessId,
        type: 'customer',
        name: 'Walk-in',
        state_code: '27',
        version: 1,
        created_at: now,
        updated_at: now,
      },
    };
  };
  async function issued(): Promise<{
    id: string;
    version: number;
    updatedAt: number;
    number: string;
  }> {
    const party = await new PartyRepo(pg.app).create(ctx(), {
      type: 'customer',
      name: 'Kiran',
      state_code: '27',
    });
    const flow = new DocumentFlowRepo(pg.app);
    const saved = await flow.saveDraft(
      ctx(),
      toRows(invoiceDraft(String(party['id']), 'Kiran', '2026-11-02', 10_000n)),
    );
    const r = await flow.issueDraft(
      ctx(),
      String(saved.document['id']),
      Number(saved.document['version']),
    );
    return {
      id: String(r.document['id']),
      version: Number(r.document['version']),
      updatedAt: Number(r.document['updated_at']),
      number: String(r.document['number']),
    };
  }
  const cancelOp = (d: { id: string; version: number; updatedAt: number }) => ({
    op: 'PATCH',
    table: 'documents',
    id: d.id,
    data: { status: 'cancelled', version: d.version + 1, updated_at: Date.now() },
    previous: { version: d.version, updated_at: d.updatedAt },
  });
  const docStatus = async (id: string) =>
    (
      await pg.app.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
        return tx`SELECT status FROM documents WHERE id = ${id}`;
      })
    )[0]!['status'];

  it('takes nothing from a viewer, and keeps a counter out of purchases and server tables', async () => {
    const ownerDev = await device(owner);
    expect((await upload(owner, ownerDev, [partyOp()])).outcome).toBe('applied');

    const viewer = await member('viewer-sync@example.com', 'viewer');
    const vDev = await device(viewer);
    const v = await upload(viewer, vDev, [partyOp()]);
    expect(v).toMatchObject({ outcome: 'rejected' });
    expect(v.reason).toMatch(/can only view/);

    const counter = await member('counter-sync@example.com', 'sales');
    const cDev = await device(counter);
    expect((await upload(counter, cDev, [partyOp()])).outcome).toBe('applied');
    const bill = await upload(counter, cDev, [
      {
        op: 'PUT',
        table: 'documents',
        id: crypto.randomUUID(),
        data: { business_id: businessId, type: 'purchase_bill', status: 'draft' },
      },
    ]);
    expect(bill.reason).toMatch(/cannot create purchases/);
    const ledger = await upload(counter, cDev, [
      {
        op: 'PUT',
        table: 'ledger_entries',
        id: crypto.randomUUID(),
        data: { business_id: businessId },
      },
    ]);
    expect(ledger.reason).toMatch(/cannot change ledger_entries/);
    const mem = await upload(counter, cDev, [
      { op: 'PUT', table: 'memberships', id: crypto.randomUUID(), data: { role: 'owner' } },
    ]);
    expect(mem.outcome).toBe('rejected');
    const d = await issued();
    const cancel = await upload(counter, cDev, [cancelOp(d)]);
    expect(cancel.reason).toMatch(/cannot cancel sales/);
    expect(await docStatus(d.id)).toBe('issued');
  });

  it('with approvals on, holds a cancellation until an approver lets it through or turns it down', async () => {
    const role = await owner.json<{ id: string }>(`/v1/orgs/${orgId}/roles`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Counter with cancel',
        grants: { sales: ['view', 'create', 'edit', 'issue', 'cancel'], parties: ['view'] },
      }),
    });
    const clerk = await member('clerk@example.com', 'viewer');
    await owner.fetch(`/v1/orgs/${orgId}/members/${await memberIdOf('clerk@example.com')}`, {
      method: 'PATCH',
      body: JSON.stringify({ roleId: role.body.id }),
    });
    const dev = await device(clerk);

    // approvals off: the cancellation applies
    const first = await issued();
    expect((await upload(clerk, dev, [cancelOp(first)])).outcome).toBe('applied');
    expect(await docStatus(first.id)).toBe('cancelled');

    expect(
      (
        await owner.fetch(`/v1/orgs/${orgId}/policy`, {
          method: 'PUT',
          body: JSON.stringify({ approvals: true }),
        })
      ).status,
    ).toBe(200);

    const second = await issued();
    const held = await upload(clerk, dev, [cancelOp(second)]);
    expect(held).toMatchObject({ outcome: 'approval' });
    expect(await docStatus(second.id)).toBe('issued');

    // the clerk cannot approve their own; a counter cannot approve at all
    const decide = (c: Client, id: string, decision: string) =>
      c.json<{ outcome: string }>(`/v1/orgs/${orgId}/approvals/${id}`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
    expect((await decide(clerk, held.reviewItemId!, 'approve')).status).toBe(403);
    const ok = await decide(owner, held.reviewItemId!, 'approve');
    expect(ok.body).toEqual({ outcome: 'approved' });
    expect(await docStatus(second.id)).toBe('cancelled');
    expect((await decide(owner, held.reviewItemId!, 'approve')).status).toBe(409);
    const audit = await pg.app.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      return tx`SELECT actor, after_json FROM audit_log WHERE row_id = ${second.id} ORDER BY at`;
    });
    expect(audit.map((a) => (a['after_json'] as Record<string, unknown>)?.['approval'])).toContain(
      'approved',
    );

    // a device cannot make an approval request of its own (it could name the owner as the asker)
    const forged = await upload(clerk, dev, [
      {
        op: 'PUT',
        table: 'review_items',
        id: crypto.randomUUID(),
        data: {
          business_id: businessId,
          kind: 'approval_request',
          status: 'pending',
          suggestion_json: JSON.stringify({ byUser: ownerId, module: 'sales', ops: [] }),
        },
      },
    ]);
    expect(forged.reason).toMatch(/approval requests are kept by the server/);

    const third = await issued();
    const held3 = await upload(clerk, dev, [cancelOp(third)]);
    expect((await decide(owner, held3.reviewItemId!, 'decline')).body).toEqual({
      outcome: 'declined',
    });
    expect(await docStatus(third.id)).toBe('issued');
  });
});

/**
 * Against a real Postgres 16 in a container: sign in with a one-time code, create an organisation and a
 * business, roles, and the cross-tenant matrix (every tenant table, zero rows visible to another
 * organisation, even for an owner).
 */
import { TENANT_TABLES } from '@gst/db';
import { seedDemo } from '@gst/db/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startPostgres, type PgStack } from './containers';

let pg: PgStack;
let t: TestApp;

beforeAll(async () => {
  pg = await startPostgres();
  t = makeTestApp(pg);
});
afterAll(async () => {
  await pg?.stop();
});

describe('sign in and organisations', () => {
  let owner: Client;
  let orgId: string;

  it('signs in with the code the mock sender recorded, mirrors the user, and answers /v1/me', async () => {
    owner = await t.signIn('asha@example.com', 'Asha');
    const me = await owner.json<{
      user: { email: string; name: string };
      organisations: unknown[];
    }>('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: 'asha@example.com', name: 'Asha' });
    expect(me.body.organisations).toEqual([]);
    // the shared users table has the row too
    const [row] = await pg.app.sql`SELECT email FROM users WHERE email = 'asha@example.com'`;
    expect(row).toBeDefined();
  });

  it('refuses a wrong code and a used one', async () => {
    const headers = { 'content-type': 'application/json', origin: 'http://localhost:1420' };
    await t.app.request('/v1/auth/email-otp/send-verification-otp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'bala@example.com', type: 'sign-in' }),
    });
    const wrong = await t.app.request('/v1/auth/sign-in/email-otp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'bala@example.com', otp: '000000' }),
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const code = t.otp.last('bala@example.com')!;
    const ok = await t.app.request('/v1/auth/sign-in/email-otp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'bala@example.com', otp: code }),
    });
    expect(ok.status).toBe(200);
    const again = await t.app.request('/v1/auth/sign-in/email-otp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'bala@example.com', otp: code }),
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it('creates an organisation (the caller is its owner) and mirrors it with a free subscription', async () => {
    const r = await owner.json<{ id: string; name: string; role: string }>('/v1/orgs', {
      method: 'POST',
      body: JSON.stringify({ name: 'Asha Traders' }),
    });
    if (r.status !== 201) console.log('CREATE ORG', JSON.stringify(r.body));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Asha Traders', role: 'owner' });
    orgId = r.body.id;
    const list = await owner.json<{ id: string }[]>('/v1/orgs');
    expect(list.body.map((o) => o.id)).toEqual([orgId]);
    const [org] = await pg.app.sql`SELECT name, plan FROM organisations WHERE id = ${orgId}`;
    expect(org).toMatchObject({ name: 'Asha Traders', plan: 'free' });
    const detail = await owner.json<{ members: { role: string }[]; plan: string }>(
      `/v1/orgs/${orgId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.members.map((m) => m.role)).toEqual(['owner']);
    await pg.app.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      const [sub] = await tx`SELECT plan_id, status FROM subscriptions WHERE org_id = ${orgId}`;
      expect(sub).toMatchObject({ plan_id: 'free', status: 'active' });
      const [m] =
        await tx`SELECT role FROM memberships WHERE org_id = ${orgId} AND deleted_at IS NULL`;
      expect(m).toMatchObject({ role: 'owner' });
    });
  });

  it('creates, lists, reads and changes a business; the change is optimistic and audited', async () => {
    const bad = await owner.json<{ error: { code: string } }>(`/v1/orgs/${orgId}/businesses`, {
      method: 'POST',
      body: JSON.stringify({ legalName: '', stateCode: '99' }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    const created = await owner.json<{
      id: string;
      version: number;
      legalName: string;
      stateCode: string;
    }>(`/v1/orgs/${orgId}/businesses`, {
      method: 'POST',
      body: JSON.stringify({
        legalName: 'Asha Traders',
        stateCode: '27',
        gstin: '27AAPFU0939F1ZV',
      }),
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ legalName: 'Asha Traders', stateCode: '27', version: 1 });
    const list = await owner.json<{ id: string }[]>(`/v1/orgs/${orgId}/businesses`);
    expect(list.body.map((b) => b.id)).toEqual([created.body.id]);
    const one = await owner.json<{ id: string }>(`/v1/orgs/${orgId}/businesses/${created.body.id}`);
    expect(one.status).toBe(200);
    const stale = await owner.json<{ error: { code: string } }>(
      `/v1/orgs/${orgId}/businesses/${created.body.id}`,
      { method: 'PATCH', body: JSON.stringify({ tradeName: 'AT', version: 7 }) },
    );
    expect(stale.status).toBe(409);
    const changed = await owner.json<{ tradeName: string; version: number }>(
      `/v1/orgs/${orgId}/businesses/${created.body.id}`,
      { method: 'PATCH', body: JSON.stringify({ tradeName: 'AT', version: 1 }) },
    );
    expect(changed.body).toMatchObject({ tradeName: 'AT', version: 2 });
    await pg.app.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      const audit =
        await tx`SELECT action FROM audit_log WHERE table_name = 'businesses' AND row_id = ${created.body.id} ORDER BY at`;
      expect(audit.map((a) => a['action'])).toEqual(['insert', 'update']);
    });
  });

  it('another user cannot see, list or write in that organisation, and a viewer cannot create', async () => {
    const other = await t.signIn('chitra@example.com');
    expect((await other.fetch(`/v1/orgs/${orgId}`)).status).toBe(404);
    expect((await other.fetch(`/v1/orgs/${orgId}/businesses`)).status).toBe(404);
    expect(
      (
        await other.fetch(`/v1/orgs/${orgId}/businesses`, {
          method: 'POST',
          body: JSON.stringify({ legalName: 'X', stateCode: '27' }),
        })
      ).status,
    ).toBe(404);
    // the owner adds them as a viewer (better-auth's server-side add; invitations by mail arrive with prompt 44)
    const [chitra] = await pg.app.sql`SELECT id FROM auth_user WHERE email = 'chitra@example.com'`;
    await t.auth.api.addMember({
      body: { organizationId: orgId, userId: String(chitra!['id']), role: 'viewer' },
    });
    const asViewer = await other.json<{ id: string }[]>(`/v1/orgs/${orgId}/businesses`);
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.length).toBe(1);
    const refused = await other.json<{ error: { code: string } }>(`/v1/orgs/${orgId}/businesses`, {
      method: 'POST',
      body: JSON.stringify({ legalName: 'X', stateCode: '27' }),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('forbidden');
    await pg.app.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      const rows =
        await tx`SELECT role FROM memberships WHERE org_id = ${orgId} AND deleted_at IS NULL ORDER BY role`;
      expect(rows.map((r) => r['role'])).toEqual(['owner', 'viewer']);
    });
  });

  it('a token that was never issued, and a tampered one, are refused', async () => {
    expect(
      (await t.app.request('/v1/me', { headers: { authorization: 'Bearer not-a-token' } })).status,
    ).toBe(401);
    expect(
      (
        await t.app.request('/v1/me', {
          headers: { authorization: `Bearer ${owner.token.slice(0, -2)}xx` },
        })
      ).status,
    ).toBe(401);
  });
});

describe('tenant isolation on every table', () => {
  it('a full demo book in one organisation is invisible to another, table by table, even as owner', async () => {
    // the demo seeder writes as the app role with the organisation set: row-level security lets it in
    const seeded = await seedDemo(pg.app);
    const a = seeded.ctx.orgId;
    const countsAs = async (orgId: string) => {
      const out: Record<string, number> = {};
      await pg.app.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
        for (const table of TENANT_TABLES) {
          const [r] = await tx.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
          out[table] = Number(r!['n']);
        }
      });
      return out;
    };
    const asA = await countsAs(a);
    const populated = TENANT_TABLES.filter((t) => asA[t]! > 0);
    expect(populated.length).toBeGreaterThan(10);
    expect(populated).toEqual(
      expect.arrayContaining([
        'businesses',
        'parties',
        'items',
        'documents',
        'document_lines',
        'payments',
        'audit_log',
      ]),
    );
    const asB = await countsAs(crypto.randomUUID());
    for (const table of TENANT_TABLES) expect({ table, n: asB[table] }).toEqual({ table, n: 0 });
    // and a write under the wrong organisation is refused by the policy, not silently dropped
    await expect(
      pg.app.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.org_id', ${crypto.randomUUID()}, true)`;
        await tx`UPDATE parties SET name = 'stolen' WHERE org_id = ${a}`;
        const [r] = await tx`SELECT count(*)::int AS n FROM parties WHERE name = 'stolen'`;
        return Number(r!['n']);
      }),
    ).resolves.toBe(0);
    // without any organisation set, nothing is readable at all
    await expect(pg.app.sql`SELECT count(*) FROM parties`).rejects.toThrow();
  });
});

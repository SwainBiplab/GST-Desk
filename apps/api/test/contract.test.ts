/**
 * Contract tests driven by the OpenAPI document the app generates: every operation declares its
 * responses, every protected operation refuses an anonymous caller with the error envelope, every
 * declared response schema can be found, and the documented success shapes match what the live app
 * answers for the organisation routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorSchema } from '../src/errors';

import { makeTestApp, type TestApp } from './app-helper';
import { startPostgres, type PgStack } from './containers';

interface Operation {
  tags?: string[];
  security?: unknown[];
  responses: Record<string, { description: string; content?: Record<string, { schema: unknown }> }>;
}
interface Doc {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
}

let pg: PgStack;
let t: TestApp;
let doc: Doc;

beforeAll(async () => {
  pg = await startPostgres();
  t = makeTestApp(pg);
  doc = (await (await t.app.request('/v1/openapi.json')).json()) as Doc;
});
afterAll(async () => {
  await pg?.stop();
});

const fill = (path: string) =>
  path
    .replace(/\{orgId\}/g, '11111111-1111-4111-8111-111111111111')
    .replace(/\{businessId\}/g, '22222222-2222-4222-8222-222222222222')
    .replace(/\{(shareId|linkId|packId|documentId)\}/g, '33333333-3333-4333-8333-333333333333')
    .replace(/\{id\}/g, '1');

describe('the OpenAPI contract', () => {
  it('every operation declares at least one response with a schema, and the error component is shared', () => {
    const ops = Object.entries(doc.paths).flatMap(([p, methods]) =>
      Object.entries(methods).map(([m, op]) => ({ p, m, op })),
    );
    expect(ops.length).toBeGreaterThan(10);
    for (const { p, m, op } of ops) {
      const withSchema = Object.values(op.responses).some(
        (r) => r.content?.['application/json']?.schema,
      );
      expect({ p, m, withSchema }).toEqual({ p, m, withSchema: true });
    }
    expect(doc.components.schemas['Error']).toBeDefined();
    expect(doc.components.schemas['Business']).toBeDefined();
  });

  it('an anonymous caller gets the error envelope on every protected operation, with a status the operation declares', async () => {
    for (const [p, methods] of Object.entries(doc.paths)) {
      for (const [m, op] of Object.entries(methods)) {
        if (!op.security?.length) continue;
        const res = await t.app.request(fill(p), {
          method: m.toUpperCase(),
          headers: { 'content-type': 'application/json' },
          ...(m === 'get' ? {} : { body: '{}' }),
        });
        expect({ p, m, status: res.status }).toEqual({ p, m, status: 401 });
        expect(Object.keys(op.responses)).toContain('401');
        const body = await res.json();
        expect({ p, m, ok: errorSchema.safeParse(body).success }).toEqual({ p, m, ok: true });
      }
    }
  });

  it('the public operations are only health, readiness, the document, auth, the customer pages (prompt 47) and (outside production) the dev code', () => {
    const open = Object.entries(doc.paths)
      .flatMap(([p, methods]) => Object.entries(methods).map(([m, op]) => ({ p, m, op })))
      .filter(({ op }) => !op.security?.length)
      .map(({ p }) => p)
      .sort();
    expect(open).toEqual(
      [
        '/healthz',
        '/readyz',
        '/v1/dev/otp',
        // a customer's link: a 128-bit token is the credential, rate limited by address and token
        '/v1/p/{token}',
        '/v1/p/{token}/pdf',
        '/v1/p/{token}/pay',
        '/v1/p/{token}/question',
      ].sort(),
    );
  });

  it('a signed-in owner gets the documented shapes back', async () => {
    const owner = await t.signIn('contract@example.com');
    const org = await owner.json<{ id: string; name: string; role: string }>('/v1/orgs', {
      method: 'POST',
      body: JSON.stringify({ name: 'Contract Co' }),
    });
    expect(org.status).toBe(201);
    expect(Object.keys(org.body).sort()).toEqual(['id', 'name', 'role']);
    const b = await owner.json<Record<string, unknown>>(`/v1/orgs/${org.body.id}/businesses`, {
      method: 'POST',
      body: JSON.stringify({ legalName: 'Contract Co', stateCode: '29' }),
    });
    expect(b.status).toBe(201);
    const businessProps = Object.keys(
      (doc.components.schemas['Business'] as { properties: Record<string, unknown> }).properties,
    ).sort();
    expect(Object.keys(b.body).sort()).toEqual(businessProps);
    const me = await owner.json<Record<string, unknown>>('/v1/me');
    const meProps = Object.keys(
      (doc.components.schemas['Me'] as { properties: Record<string, unknown> }).properties,
    ).sort();
    expect(Object.keys(me.body).sort()).toEqual(meProps);
  });
});

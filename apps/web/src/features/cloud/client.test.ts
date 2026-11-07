import { describe, expect, it } from 'vitest';

import { CloudClient, CloudError, isAllowedApiUrl, readSession, writeSession } from './client';

/** A fake API: records requests, answers what the real one answers. */
function fakeApi() {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] =
    [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    const json = (status: number, b: unknown, h: Record<string, string> = {}) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { 'content-type': 'application/json', ...h },
      });
    if (url.endsWith('/v1/auth/email-otp/send-verification-otp'))
      return json(200, { success: true });
    if (url.includes('/v1/dev/otp')) return json(200, { to: body?.email ?? 'x', code: '123456' });
    if (url.endsWith('/v1/auth/sign-in/email-otp'))
      return body.otp === '123456'
        ? json(200, { user: { id: 'u1' } }, { 'set-auth-token': 'tok-1' })
        : json(400, { message: 'Invalid OTP', code: 'INVALID_OTP' });
    if (url.endsWith('/v1/me'))
      return headers['authorization'] === 'Bearer tok-1'
        ? json(200, {
            user: { id: 'u1', email: 'a@x.in', phone: null, name: 'A', locale: 'en' },
            organisations: [],
            activeOrganizationId: null,
          })
        : json(401, {
            error: { code: 'unauthorized', message: 'Sign in to continue.', requestId: 'r1' },
          });
    if (url.endsWith('/v1/orgs') && init?.method === 'POST')
      return json(201, {
        id: '11111111-1111-4111-8111-111111111111',
        name: body.name,
        role: 'owner',
      });
    if (url.endsWith('/businesses') && init?.method === 'POST')
      return body.stateCode
        ? json(201, {
            id: 'b1',
            legalName: body.legalName,
            tradeName: null,
            gstin: body.gstin ?? null,
            stateCode: body.stateCode,
            scheme: 'regular',
            fyStartMonth: 4,
            version: 1,
          })
        : json(400, { error: { code: 'validation', message: 'bad', requestId: 'r2' } });
    return json(404, { error: { code: 'not_found', message: 'No such route.', requestId: 'r3' } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('the cloud client', () => {
  it('signs in with a code, keeps the token, and sends it on every later call', async () => {
    const api = fakeApi();
    const c = new CloudClient('http://localhost:8787', null, api.fetchFn);
    await c.sendEmailCode('a@x.in');
    expect(api.calls[0]).toMatchObject({
      url: 'http://localhost:8787/v1/auth/email-otp/send-verification-otp',
      body: { email: 'a@x.in', type: 'sign-in' },
    });
    await expect(c.signInWithEmailCode('a@x.in', '000000')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_OTP',
    });
    const token = await c.signInWithEmailCode('a@x.in', '123456');
    expect(token).toBe('tok-1');
    const me = await c.me();
    expect(me.user.email).toBe('a@x.in');
    expect(api.calls.at(-1)?.headers['authorization']).toBe('Bearer tok-1');
    const org = await c.createOrganisation('Asha Traders');
    expect(org.role).toBe('owner');
    const b = await c.createBusiness(org.id, { legalName: 'Asha Traders', stateCode: '27' });
    expect(b.id).toBe('b1');
  });

  it('turns the error envelope into a typed error and an anonymous call into 401', async () => {
    const api = fakeApi();
    const c = new CloudClient('http://localhost:8787', null, api.fetchFn);
    const err = await c.me().catch((e) => e as CloudError);
    expect(err).toBeInstanceOf(CloudError);
    expect(err).toMatchObject({ status: 401, code: 'unauthorized', requestId: 'r1' });
    const bad = await new CloudClient('http://localhost:8787', 'tok-1', api.fetchFn)
      .createBusiness('o', { legalName: 'X', stateCode: '' })
      .catch((e) => e as CloudError);
    expect(bad).toMatchObject({ status: 400, code: 'validation' });
  });

  it('allows https anywhere and plain http only to this machine, and keeps the session in storage', () => {
    expect(isAllowedApiUrl('https://api.example.in')).toBe(true);
    expect(isAllowedApiUrl('http://localhost:8787')).toBe(true);
    expect(isAllowedApiUrl('http://api.example.in')).toBe(false);
    expect(isAllowedApiUrl('ftp://x')).toBe(false);
    const mem = new Map<string, string>();
    const set = (k: string, v: string | null) => (v === null ? mem.delete(k) : mem.set(k, v));
    const get = (k: string) => mem.get(k) ?? null;
    writeSession(set, {
      baseUrl: 'https://api.example.in',
      token: 't',
      email: 'a@x.in',
      signedInAt: 1,
    });
    expect(readSession(get)).toMatchObject({ token: 't', email: 'a@x.in' });
    writeSession(set, null);
    expect(readSession(get)).toBeNull();
    mem.set('cloud.session', '{broken');
    expect(readSession(get)).toBeNull();
  });
});

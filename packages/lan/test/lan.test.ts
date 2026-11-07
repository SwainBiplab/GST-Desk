import { describe, expect, it } from 'vitest';

import {
  EditLocks,
  LOCK_TTL_MS,
  LOCKOUT_MS,
  LanBridge,
  MAX_WRONG_GUESSES,
  MemoryDeviceStore,
  PAIRING_TTL_MS,
  Pairer,
  RateLimiter,
  TOKEN_GRACE_MS,
  TOKEN_ROTATE_AFTER_MS,
  allows,
  decode,
  encode,
  hashToken,
  newToken,
  pairingUri,
  sameSecret,
  type MethodDef,
} from '../src';

describe('wire', () => {
  it('carries a bigint through JSON and leaves everything else alone', () => {
    const v = {
      a: 12_345_678_901_234_567_890n,
      b: [1n, -2n],
      c: 'x',
      d: { $big: 'nope', extra: 1 },
    };
    const back = decode<typeof v>(encode(v));
    expect(back.a).toBe(12_345_678_901_234_567_890n);
    expect(back.b).toEqual([1n, -2n]);
    expect(back.d).toEqual({ $big: 'nope', extra: 1 });
  });
});

describe('tokens', () => {
  it('makes long distinct tokens, hashes them, and compares without stopping early', async () => {
    const a = newToken();
    expect(a).toHaveLength(43);
    expect(newToken()).not.toBe(a);
    expect(await hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken(a)).toBe(await hashToken(a));
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });
});

describe('roles and rate limits', () => {
  it('lets a view device look, a counter bill, and only a full device administer', () => {
    expect(['read', 'sell', 'admin'].map((a) => allows('view', a as never))).toEqual([
      true,
      false,
      false,
    ]);
    expect(['read', 'sell', 'admin'].map((a) => allows('counter', a as never))).toEqual([
      true,
      true,
      false,
    ]);
    expect(['read', 'sell', 'admin'].map((a) => allows('full', a as never))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('allows a burst, then the average rate, and keeps keys apart', () => {
    const l = new RateLimiter(2, 3);
    expect([1, 2, 3, 4].map(() => l.allow('a', 0))).toEqual([true, true, true, false]);
    expect(l.allow('b', 0)).toBe(true);
    expect(l.allow('a', 500)).toBe(true); // half a second at 2 a second makes one token
    expect(l.allow('a', 500)).toBe(false);
  });
});

describe('pairing', () => {
  it('makes an 8-digit code that works once, for the role it was made for', () => {
    const p = new Pairer();
    const o = p.start(0, 'view');
    expect(o.code).toMatch(/^\d{8}$/);
    expect(p.redeem(o.code, 'ip', 1)).toEqual({ ok: true, role: 'view' });
    expect(p.redeem(o.code, 'ip', 2)).toEqual({ ok: false, code: 'no_offer' });
  });

  it('expires after five minutes and a new code replaces the old one', () => {
    const p = new Pairer();
    const o = p.start(0);
    expect(p.open(PAIRING_TTL_MS - 1)?.code).toBe(o.code);
    expect(p.redeem(o.code, 'ip', PAIRING_TTL_MS)).toEqual({ ok: false, code: 'expired' });
    const a = p.start(0);
    const b = p.start(0);
    expect(p.redeem(a.code, 'ip', 1).ok).toBe(a.code === b.code);
  });

  it('burns the code after five wrong guesses and shuts that source out for a minute', () => {
    const p = new Pairer();
    const o = p.start(0);
    const wrong = o.code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < MAX_WRONG_GUESSES; i++)
      expect(p.redeem(wrong, 'bad', 1)).toEqual({ ok: false, code: 'wrong_code' });
    // even the right code no longer works: it was burned
    expect(p.redeem(o.code, 'bad', 2)).toEqual({ ok: false, code: 'locked' });
    const fresh = p.start(3);
    expect(p.redeem(fresh.code, 'bad', 4)).toEqual({ ok: false, code: 'locked' });
    expect(p.redeem(fresh.code, 'other', 4).ok).toBe(true);
    const again = p.start(5);
    expect(p.redeem(again.code, 'bad', LOCKOUT_MS + 10).ok).toBe(true);
  });

  it('writes the QR address with the code and the certificate fingerprint to pin', () => {
    expect(
      pairingUri({ host: 'gstdesk.local', port: 47372, code: '12345678', fingerprint: 'ab:cd' }),
    ).toBe('https://gstdesk.local:47372/pair?code=12345678&fp=ab%3Acd');
  });
});

describe('edit locks', () => {
  const a = { deviceId: 'a', name: 'Counter 1' };
  const b = { deviceId: 'b', name: 'Counter 2' };

  it('gives one writer at a time, names the holder, and lets the holder come back', () => {
    const l = new EditLocks();
    expect(l.acquire('doc1', a, 0)).toEqual({ ok: true });
    expect(l.acquire('doc1', a, 1)).toEqual({ ok: true });
    expect(l.acquire('doc1', b, 2)).toEqual({ ok: false, holder: a });
    expect(l.acquire('doc2', b, 2)).toEqual({ ok: true });
  });

  it('lapses unless renewed, and a takeover says who it was taken from', () => {
    const l = new EditLocks();
    l.acquire('doc1', a, 0);
    expect(l.heartbeat('doc1', 'a', LOCK_TTL_MS - 1)).toBe(true);
    expect(l.holderOf('doc1', 2 * LOCK_TTL_MS - 2)).toEqual(a);
    expect(l.holderOf('doc1', 3 * LOCK_TTL_MS)).toBeNull();
    expect(l.acquire('doc1', b, 3 * LOCK_TTL_MS)).toEqual({ ok: true });
    expect(l.takeOver('doc1', a, 3 * LOCK_TTL_MS + 1)).toEqual({ ok: true, tookOverFrom: b });
    expect(l.heartbeat('doc1', 'b', 3 * LOCK_TTL_MS + 2)).toBe(false);
  });

  it('lets go of everything a device held', () => {
    const l = new EditLocks();
    l.acquire('x', a, 0);
    l.acquire('y', a, 0);
    l.release('x', 'b'); // not the holder: nothing happens
    expect(l.holderOf('x', 1)).toEqual(a);
    l.releaseAll('a');
    expect(l.holderOf('x', 1)).toBeNull();
    expect(l.holderOf('y', 1)).toBeNull();
  });
});

function rig(enabled = true) {
  const store = new MemoryDeviceStore();
  let now = 1_000_000;
  const calls: string[] = [];
  const doc = new Map<string, number>();
  const methods = new Map<string, MethodDef>([
    ['parties.list', { access: 'read', run: async () => ['Sharma'] }],
    [
      'documents.save',
      {
        access: 'sell',
        lock: (p: { id: string }) => `doc:${p.id}`,
        run: async (p: { id: string }) => {
          calls.push(`save ${p.id}`);
          doc.set(p.id, (doc.get(p.id) ?? 0) + 1);
          return { id: p.id, total: 123_456n };
        },
      },
    ],
    ['settings.set', { access: 'admin', run: async () => 'ok' }],
    [
      'boom',
      {
        access: 'read',
        run: async () => {
          throw new Error('the book is locked');
        },
      },
    ],
  ]);
  const bridge = new LanBridge({
    store,
    methods,
    clock: () => now,
    enabled: () => enabled,
    newId: (() => {
      let n = 0;
      return () => `dev${++n}`;
    })(),
  });
  const call = (token: string | undefined, method: string, params: unknown = {}, ip = '10.0.0.5') =>
    bridge.handle({ route: 'rpc', ip, token, body: encode({ method, params }) });
  const pair = async (role: 'full' | 'counter' | 'view', name = 'Counter 1', ip = '10.0.0.5') => {
    const offer = bridge.startPairing(role);
    const r = await bridge.handle({
      route: 'pair',
      ip,
      body: encode({ code: offer.code, name, platform: 'Android' }),
    });
    return {
      r,
      body: decode<{ ok: boolean; result?: { token: string; deviceId: string; role: string } }>(
        r.body,
      ),
    };
  };
  return {
    store,
    bridge,
    call,
    pair,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('the bridge: pairing', () => {
  it('pairs with the one-time code, gives a token once, and stores only its hash', async () => {
    const t = rig();
    const { r, body } = await t.pair('counter');
    expect(r.status).toBe(200);
    const token = body.result!.token;
    const stored = [...t.store.devices.values()][0]!;
    expect(stored).toMatchObject({ name: 'Counter 1', role: 'counter', platform: 'Android' });
    expect(stored.tokenHash).toBe(await hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    // the code is used up
    const again = await t.bridge.handle({
      route: 'pair',
      ip: '10.0.0.5',
      body: encode({ code: '00000000', name: 'X' }),
    });
    expect(again.status).toBe(403);
  });

  it('refuses a bad request, a wrong code, and too many tries from one address', async () => {
    const t = rig();
    t.bridge.startPairing('full');
    const bad = await t.bridge.handle({ route: 'pair', ip: 'a', body: 'nope' });
    expect(bad.status).toBe(400);
    const noName = await t.bridge.handle({ route: 'pair', ip: 'a', body: encode({ code: '1' }) });
    expect(noName.status).toBe(400);
    const wrong = await t.bridge.handle({
      route: 'pair',
      ip: 'a',
      body: encode({ code: '0', name: 'X' }),
    });
    expect(wrong.status).toBe(403);
    expect(decode<{ error: { code: string } }>(wrong.body).error.code).toBe('wrong_code');
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (
        await t.bridge.handle({ route: 'pair', ip: 'a', body: encode({ code: '0', name: 'X' }) })
      ).status;
    expect([403, 429]).toContain(last);
    expect(last).toBe(429);
  });
});

describe('the bridge: enforcement', () => {
  it('refuses everything when LAN access is off', async () => {
    const t = rig(false);
    const r = await t.bridge.handle({ route: 'ping', ip: 'x', body: '' });
    expect(r.status).toBe(503);
    expect((await t.call('t', 'parties.list')).status).toBe(503);
  });

  it('needs a good token, and a revoked one stops working at once', async () => {
    const t = rig();
    expect((await t.call(undefined, 'parties.list')).status).toBe(401);
    expect((await t.call('not-a-token', 'parties.list')).status).toBe(401);
    const { body } = await t.pair('view');
    const token = body.result!.token;
    const ok = await t.call(token, 'parties.list');
    expect(ok.status).toBe(200);
    expect(decode<{ result: string[] }>(ok.body).result).toEqual(['Sharma']);
    expect(await t.bridge.revoke(body.result!.deviceId)).toBe(true);
    const gone = await t.call(token, 'parties.list');
    expect(gone.status).toBe(401);
    expect(decode<{ error: { code: string } }>(gone.body).error.code).toBe('revoked');
    expect(await t.bridge.revoke(body.result!.deviceId)).toBe(false);
  });

  it('enforces the role on the server: view looks, counter bills, only full administers', async () => {
    const t = rig();
    const view = (await t.pair('view', 'V')).body.result!.token;
    const counter = (await t.pair('counter', 'C')).body.result!.token;
    const full = (await t.pair('full', 'F')).body.result!.token;
    expect((await t.call(full, 'settings.set')).status).toBe(200);
    const status = async (tok: string, m: string) => (await t.call(tok, m, { id: 'd1' })).status;
    expect([
      await status(view, 'parties.list'),
      await status(view, 'documents.save'),
      await status(view, 'settings.set'),
    ]).toEqual([200, 403, 403]);
    expect([
      await status(counter, 'documents.save'),
      await status(counter, 'settings.set'),
    ]).toEqual([200, 403]);
  });

  it('knows no unknown method, and reports a failure inside a call without hiding it', async () => {
    const t = rig();
    const tok = (await t.pair('full')).body.result!.token;
    expect((await t.call(tok, 'nothing.here')).status).toBe(404);
    const b = await t.call(tok, 'boom');
    expect(b.status).toBe(200);
    expect(decode<{ ok: boolean; error: { message: string } }>(b.body)).toMatchObject({
      ok: false,
      error: { message: 'the book is locked' },
    });
  });

  it('carries bigint money across the wire in both directions', async () => {
    const t = rig();
    const tok = (await t.pair('counter')).body.result!.token;
    const r = decode<{ result: { total: bigint } }>(
      (await t.call(tok, 'documents.save', { id: 'd9' })).body,
    );
    expect(r.result.total).toBe(123_456n);
  });

  it('slows a device that asks too fast, and an address that is not paired', async () => {
    const t = rig();
    const tok = (await t.pair('view')).body.result!.token;
    const statuses: number[] = [];
    for (let i = 0; i < 130; i++) statuses.push((await t.call(tok, 'parties.list')).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    const anon: number[] = [];
    for (let i = 0; i < 40; i++)
      anon.push((await t.call(undefined, 'parties.list', {}, '10.9.9.9')).status);
    expect(anon).toContain(429);
  });

  it('refuses a request that is too large or not JSON', async () => {
    const t = rig();
    const tok = (await t.pair('full')).body.result!.token;
    expect(
      (await t.bridge.handle({ route: 'rpc', ip: 'x', token: tok, body: 'x'.repeat(1_000_001) }))
        .status,
    ).toBe(400);
    expect(
      (await t.bridge.handle({ route: 'rpc', ip: 'x', token: tok, body: '{bad' })).status,
    ).toBe(400);
  });
});

describe('the bridge: limits', () => {
  it("lets a paired device work at a counter's pace: the address limit is for strangers", async () => {
    const t = rig();
    const tok = (await t.pair('counter')).body.result!.token;
    const statuses: number[] = [];
    // 40 calls in the same instant from one address is far above what strangers get and inside a device's own bucket
    for (let i = 0; i < 40; i++) statuses.push((await t.call(tok, 'parties.list')).status);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('still slows an address that keeps offering bad tokens', async () => {
    const t = rig();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++)
      statuses.push((await t.call('guess', 'parties.list', {}, '10.7.7.7')).status);
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
  });
});

describe('the bridge: two tablets billing', () => {
  it('lets one edit a document at a time, tells the second who has it, and lets it take over', async () => {
    const t = rig();
    const one = (await t.pair('counter', 'Counter 1')).body.result!.token;
    const two = (await t.pair('counter', 'Counter 2')).body.result!.token;
    expect((await t.call(one, 'documents.save', { id: 'inv1' })).status).toBe(200);
    const blocked = await t.call(two, 'documents.save', { id: 'inv1' });
    expect(blocked.status).toBe(409);
    expect(
      decode<{ error: { code: string; holder: { name: string } } }>(blocked.body).error,
    ).toMatchObject({ code: 'locked', holder: { name: 'Counter 1' } });
    // a different document is free
    expect((await t.call(two, 'documents.save', { id: 'inv2' })).status).toBe(200);

    const take = await t.call(two, 'lock.takeOver', { resource: 'doc:inv1' });
    expect(
      decode<{ result: { tookOverFrom: { name: string } } }>(take.body).result.tookOverFrom.name,
    ).toBe('Counter 1');
    // the first is told on its next heartbeat, and can no longer save
    const hb = await t.call(one, 'lock.heartbeat', { resource: 'doc:inv1' });
    expect(hb.status).toBe(409);
    expect(decode<{ error: { code: string; message: string } }>(hb.body).error).toMatchObject({
      code: 'lock_lost',
      message: 'Taken over by Counter 2.',
    });
    expect((await t.call(one, 'documents.save', { id: 'inv1' })).status).toBe(409);
    expect((await t.call(two, 'documents.save', { id: 'inv1' })).status).toBe(200);
  });

  it("lets go of a revoked device's locks so the document is free again", async () => {
    const t = rig();
    const a = await t.pair('counter', 'A');
    const b = (await t.pair('counter', 'B')).body.result!.token;
    await t.call(a.body.result!.token, 'documents.save', { id: 'inv7' });
    expect((await t.call(b, 'documents.save', { id: 'inv7' })).status).toBe(409);
    await t.bridge.revoke(a.body.result!.deviceId);
    expect((await t.call(b, 'documents.save', { id: 'inv7' })).status).toBe(200);
  });

  it('lets a document go when it is issued, and keeps it when the call fails', async () => {
    const t = rig();
    const methods = new Map<string, MethodDef>([
      [
        'documents.issue',
        {
          access: 'sell',
          lock: (p: { id: string }) => `doc:${p.id}`,
          releaseAfter: true,
          run: async () => 'issued',
        },
      ],
      [
        'documents.fail',
        {
          access: 'sell',
          lock: (p: { id: string }) => `doc:${p.id}`,
          releaseAfter: true,
          run: async () => {
            throw new Error('no');
          },
        },
      ],
    ]);
    const b = new LanBridge({ store: t.store, methods, clock: t.now, enabled: () => true });
    const offer = b.startPairing('counter');
    const paired = decode<{ result: { token: string } }>(
      (await b.handle({ route: 'pair', ip: 'a', body: encode({ code: offer.code, name: 'One' }) }))
        .body,
    );
    const call = (m: string) =>
      b.handle({
        route: 'rpc',
        ip: 'a',
        token: paired.result.token,
        body: encode({ method: m, params: { id: 'd1' } }),
      });
    await call('documents.issue');
    expect(b.locks.holderOf('doc:d1', t.now())).toBeNull();
    await call('documents.fail');
    expect(b.locks.holderOf('doc:d1', t.now())?.name).toBe('One');
  });

  it('a view device cannot take a lock', async () => {
    const t = rig();
    const v = (await t.pair('view')).body.result!.token;
    expect((await t.call(v, 'lock.acquire', { resource: 'doc:x' })).status).toBe(403);
  });
});

describe('the bridge: token rotation', () => {
  it('replaces a token after 30 days, keeps the old one for a short grace, then refuses it', async () => {
    const t = rig();
    const { body } = await t.pair('view');
    const old = body.result!.token;
    t.advance(TOKEN_ROTATE_AFTER_MS + 1000);
    const r = await t.call(old, 'parties.list');
    expect(r.status).toBe(200);
    const fresh = decode<{ rotatedToken: string }>(r.body).rotatedToken;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(old);
    // the new token works and does not rotate again; the old works within the grace
    const next = await t.call(fresh, 'parties.list');
    expect(decode<{ rotatedToken?: string }>(next.body).rotatedToken).toBeUndefined();
    expect((await t.call(old, 'parties.list')).status).toBe(200);
    t.advance(TOKEN_GRACE_MS + 1000);
    expect((await t.call(old, 'parties.list')).status).toBe(401);
    expect((await t.call(fresh, 'parties.list')).status).toBe(200);
  });
});

describe('the bridge: managing devices', () => {
  it('lists, renames and changes the role of a device, and refuses a bad change', async () => {
    const t = rig();
    const { body } = await t.pair('counter', 'Tablet');
    const id = body.result!.deviceId;
    expect((await t.bridge.devices()).map((d) => d.name)).toEqual(['Tablet']);
    expect(await t.bridge.rename(id, '  Counter 3 ')).toBe(true);
    expect(await t.bridge.rename(id, '')).toBe(false);
    expect(await t.bridge.rename(id, 'x'.repeat(41))).toBe(false);
    expect(await t.bridge.setRole(id, 'view')).toBe(true);
    expect(await t.bridge.setRole(id, 'root' as never)).toBe(false);
    const tok = body.result!.token;
    // the new role applies on the very next request
    expect((await t.call(tok, 'documents.save', { id: 'z' })).status).toBe(403);
    expect((await t.bridge.devices())[0]).toMatchObject({ name: 'Counter 3', role: 'view' });
  });
});

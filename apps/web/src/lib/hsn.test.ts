import { generateKeyPairSync, sign } from 'node:crypto';

import {
  SettingsRepo,
  createOrganisation,
  BusinessRepo,
  listHsnVersions,
  lookupHsn,
  migrate,
  type Ctx,
  type Database,
} from '@gst/db';
import { openSqlite } from '@gst/db/node';
import { manifestMessage, sha256Hex, type HsnDataFile, type HsnManifest } from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HSN_UPDATE_KEY, checkForHsnUpdate, ensureBundledHsn, isAllowedUpdateUrl } from './hsn';

let d: Database;
let ctx: Ctx;

beforeAll(async () => {
  d = await openSqlite();
  await migrate(d);
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 't', deviceId: 'd' };
  const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
  ctx = { ...base, businessId: biz['id'] };
}, 60_000);
afterAll(async () => {
  await d.close();
});

const setUrl = (url: string) => new SettingsRepo(d).set(ctx, HSN_UPDATE_KEY, url);

/** A signed update, and a fetch that serves it from `https://updates.example/hsn/`. */
async function server(
  version: string,
  rows: HsnDataFile['rows'],
  over: { tamper?: boolean; wrongKey?: boolean } = {},
) {
  const pair = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const data: HsnDataFile = { version, as_of: '2026-04-01', source: 'test', rows };
  const dataText = JSON.stringify(data);
  const base = {
    version,
    as_of: data.as_of,
    count: rows.length,
    sha256: await sha256Hex(dataText),
  };
  const manifest: HsnManifest = {
    ...base,
    file: `hsn-v${version}.json`,
    keyId: 'test',
    signature: sign(
      null,
      Buffer.from(manifestMessage(base)),
      over.wrongKey ? other.privateKey : pair.privateKey,
    ).toString('base64'),
  };
  const served = new Map<string, string>([
    ['https://updates.example/hsn/manifest.json', JSON.stringify(manifest)],
    [
      `https://updates.example/hsn/hsn-v${version}.json`,
      over.tamper ? dataText.replace('1200', '0') : dataText,
    ],
  ]);
  const fetchFn = (async (url: string | URL | Request) => {
    const body = served.get(String(url));
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
  }) as typeof fetch;
  return { fetchFn, key: { keyId: 'test', publicKeyBase64: raw.toString('base64') } };
}

const TEA_UP = [
  { code: '0902', description: 'Tea', rate_bp: 1200, cess_bp: 0, effective_from: '2026-04-01' },
];

describe('bundled master', () => {
  it('loads once, verified, and then leaves the database alone', async () => {
    const first = await ensureBundledHsn(d);
    expect(first).toMatchObject({ skipped: false, inserted: 112 });
    expect(await ensureBundledHsn(d)).toBeNull();
    expect((await listHsnVersions(d))[0]).toMatchObject({ version: '2025.9.1', row_count: 112 });
    expect(await lookupHsn(d, '0902', '2026-01-01')).toMatchObject({ rate_bp: 500 });
    expect(await lookupHsn(d, '9954', '2026-01-01')).toMatchObject({ rate_bp: 1800 });
  });
});

describe('update check', () => {
  it('does nothing and fetches nothing when no address is set', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response('');
    }) as unknown as typeof fetch;
    expect(await checkForHsnUpdate(d, ctx, fetchFn)).toEqual({ status: 'off' });
    expect(calls).toBe(0);
  });

  it('refuses an address that is not https', async () => {
    await setUrl('http://updates.example/hsn/manifest.json');
    expect(await checkForHsnUpdate(d, ctx)).toEqual({ status: 'error', message: 'url' });
    expect(isAllowedUpdateUrl('http://localhost:8080/m.json')).toBe(true);
    expect(isAllowedUpdateUrl('ftp://x/y')).toBe(false);
    expect(isAllowedUpdateUrl('nonsense')).toBe(false);
  });

  it('reports network and format problems without changing anything', async () => {
    await setUrl('https://updates.example/hsn/manifest.json');
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await checkForHsnUpdate(d, ctx, down)).toEqual({ status: 'error', message: 'network' });
    const junk = (async () => new Response('{"hello":1}')) as unknown as typeof fetch;
    expect(await checkForHsnUpdate(d, ctx, junk)).toEqual({ status: 'error', message: 'format' });
    const html = (async () => new Response('<html>')) as unknown as typeof fetch;
    expect((await checkForHsnUpdate(d, ctx, html)).status).toBe('error');
  });

  it('says current when the offered version is not newer', async () => {
    const { fetchFn, key } = await server('2025.9.1', TEA_UP);
    expect(await checkForHsnUpdate(d, ctx, fetchFn, key)).toEqual({
      status: 'current',
      version: '2025.9.1',
    });
  });

  it('refuses tampered data and a manifest signed by the wrong key, and changes nothing', async () => {
    const tampered = await server('2026.4.0', TEA_UP, { tamper: true });
    expect(await checkForHsnUpdate(d, ctx, tampered.fetchFn, tampered.key)).toEqual({
      status: 'rejected',
      reason: 'hash',
    });
    const forged = await server('2026.4.0', TEA_UP, { wrongKey: true });
    expect(await checkForHsnUpdate(d, ctx, forged.fetchFn, forged.key)).toEqual({
      status: 'rejected',
      reason: 'signature',
    });
    const otherKey = await server('2026.4.0', TEA_UP);
    expect(
      await checkForHsnUpdate(d, ctx, otherKey.fetchFn, { ...otherKey.key, keyId: 'another' }),
    ).toEqual({
      status: 'rejected',
      reason: 'key',
    });
    expect((await listHsnVersions(d)).map((v) => v.version)).toEqual(['2025.9.1']);
    expect(await lookupHsn(d, '0902', '2026-06-01')).toMatchObject({ rate_bp: 500 });
  });

  it('imports a correctly signed newer version and keeps the old rate in history', async () => {
    const { fetchFn, key } = await server('2026.4.0', TEA_UP);
    expect(await checkForHsnUpdate(d, ctx, fetchFn, key)).toEqual({
      status: 'updated',
      version: '2026.4.0',
      rateChanges: 1,
    });
    expect((await listHsnVersions(d)).map((v) => v.version)).toEqual(['2026.4.0', '2025.9.1']);
    expect(await lookupHsn(d, '0902', '2026-03-31')).toMatchObject({ rate_bp: 500 });
    expect(await lookupHsn(d, '0902', '2026-04-01')).toMatchObject({ rate_bp: 1200 });
    // asking again finds nothing newer
    expect(await checkForHsnUpdate(d, ctx, fetchFn, key)).toEqual({
      status: 'current',
      version: '2026.4.0',
    });
  });
});

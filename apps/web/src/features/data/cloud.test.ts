import { describe, expect, it } from 'vitest';

import {
  CloudError,
  FOLDER_NAME,
  ONEDRIVE_CHUNK,
  ONEDRIVE_SIMPLE_MAX,
  accessToken,
  uploadBackup,
  type CloudCredentials,
} from './cloud';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake network that answers in order, and remembers what it was asked. */
function network(answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: { ...((init.headers as Record<string, string>) ?? {}) },
      body: init.body,
    });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const google: CloudCredentials = {
  provider: 'google',
  clientId: 'my-client',
  clientSecret: 'my-secret',
  refreshToken: 'my-refresh',
};
const onedrive: CloudCredentials = {
  provider: 'onedrive',
  clientId: 'my-client',
  refreshToken: 'my-refresh',
};
const bytes = (n: number) => new Uint8Array(n).fill(7);

describe('signing in', () => {
  it('trades the refresh token for an access token with the person’s own credentials', async () => {
    const net = network([json({ access_token: 'ACCESS' })]);
    expect(await accessToken(google, net.f)).toBe('ACCESS');
    const c = net.calls[0]!;
    expect(c.url).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(c.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'my-client',
      client_secret: 'my-secret',
      refresh_token: 'my-refresh',
    });
  });

  it('uses Microsoft’s endpoint and scope for OneDrive, with no secret when there is none', async () => {
    const net = network([json({ access_token: 'T' })]);
    await accessToken(onedrive, net.f);
    expect(net.calls[0]!.url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    const body = new URLSearchParams(String(net.calls[0]!.body));
    expect(body.get('scope')).toBe('Files.ReadWrite offline_access');
    expect(body.has('client_secret')).toBe(false);
  });

  it('asks for the missing pieces before any request', async () => {
    const net = network([]);
    await expect(accessToken({ ...google, refreshToken: '' }, net.f)).rejects.toMatchObject({
      kind: 'setup',
    });
    expect(net.calls).toHaveLength(0);
  });

  it('says it was refused, as an auth problem, without repeating any secret', async () => {
    const net = network([
      new Response(JSON.stringify({ error: 'invalid_grant', detail: 'my-refresh' }), {
        status: 400,
      }),
    ]);
    const err = await accessToken(google, net.f).catch((e) => e);
    expect(err).toBeInstanceOf(CloudError);
    const net401 = network([json({}, 401)]);
    const auth = await accessToken(google, net401.f).catch((e) => e);
    expect(auth.kind).toBe('auth');
    for (const e of [err, auth])
      for (const secret of ['my-refresh', 'my-secret', 'my-client'])
        expect(e.message).not.toContain(secret);
  });

  it('says so when the network is down', async () => {
    const net = network([new TypeError('fetch failed')]);
    await expect(accessToken(google, net.f)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('Google Drive', () => {
  it('finds its folder and uploads the file into it, with the access token on every request', async () => {
    const data = bytes(1000);
    const net = network([
      json({ access_token: 'ACCESS' }),
      json({ files: [{ id: 'folder-1' }] }),
      new Response('{}', {
        status: 200,
        headers: { Location: 'https://upload.example/session-1' },
      }),
      json({ id: 'file-1', name: 'manual-20250301T000000Z.gstbk' }),
    ]);
    const r = await uploadBackup(google, 'manual-20250301T000000Z.gstbk', data, net.f);
    expect(r).toEqual({ provider: 'google', id: 'file-1', name: 'manual-20250301T000000Z.gstbk' });
    const [, find, start, put] = net.calls;
    expect(decodeURIComponent(find!.url)).toContain(`name = '${FOLDER_NAME}'`);
    expect(find!.headers['Authorization']).toBe('Bearer ACCESS');
    expect(JSON.parse(String(start!.body))).toEqual({
      name: 'manual-20250301T000000Z.gstbk',
      parents: ['folder-1'],
    });
    expect(start!.headers['X-Upload-Content-Length']).toBe('1000');
    expect(put!.url).toBe('https://upload.example/session-1');
    expect((put!.body as Uint8Array).length).toBe(1000);
  });

  it('makes the folder when there is none', async () => {
    const net = network([
      json({ access_token: 'A' }),
      json({ files: [] }),
      json({ id: 'new-folder' }),
      new Response('{}', { headers: { Location: 'https://upload.example/s' } }),
      json({ id: 'f', name: 'n.gstbk' }),
    ]);
    await uploadBackup(google, 'n.gstbk', bytes(10), net.f);
    expect(JSON.parse(String(net.calls[2]!.body))).toMatchObject({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    });
    expect(JSON.parse(String(net.calls[3]!.body)).parents).toEqual(['new-folder']);
  });

  it('stops with a clear error if the drive gives no place to send the file', async () => {
    const net = network([
      json({ access_token: 'A' }),
      json({ files: [{ id: 'x' }] }),
      new Response('{}', { status: 200 }),
    ]);
    await expect(uploadBackup(google, 'n', bytes(10), net.f)).rejects.toMatchObject({
      kind: 'server',
    });
  });
});

describe('OneDrive', () => {
  it('uploads a small file in one request to the backup folder', async () => {
    const net = network([
      json({ access_token: 'TOKEN' }),
      json({ id: 'item-1', name: 'a b.gstbk' }),
    ]);
    const r = await uploadBackup(onedrive, 'a b.gstbk', bytes(ONEDRIVE_SIMPLE_MAX), net.f);
    expect(r.id).toBe('item-1');
    const put = net.calls[1]!;
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(
      `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURIComponent(FOLDER_NAME)}/a%20b.gstbk:/content`,
    );
    expect(put.headers['Authorization']).toBe('Bearer TOKEN');
  });

  it('sends a big file in pieces that are multiples of 320 KiB, with the right ranges, and no token to the upload address', async () => {
    const size = ONEDRIVE_CHUNK * 2 + 12345;
    const net = network([
      json({ access_token: 'TOKEN' }),
      json({ uploadUrl: 'https://upload.example/u1' }),
      json({}, 202),
      json({}, 202),
      json({ id: 'item-2', name: 'big.gstbk' }, 201),
    ]);
    const r = await uploadBackup(onedrive, 'big.gstbk', bytes(size), net.f);
    expect(r).toMatchObject({ id: 'item-2' });
    const pieces = net.calls.slice(2);
    expect(pieces.map((p) => p.headers['Content-Range'])).toEqual([
      `bytes 0-${ONEDRIVE_CHUNK - 1}/${size}`,
      `bytes ${ONEDRIVE_CHUNK}-${ONEDRIVE_CHUNK * 2 - 1}/${size}`,
      `bytes ${ONEDRIVE_CHUNK * 2}-${size - 1}/${size}`,
    ]);
    expect(ONEDRIVE_CHUNK % (320 * 1024)).toBe(0);
    for (const p of pieces) {
      expect(p.url).toBe('https://upload.example/u1');
      expect(p.headers['Authorization']).toBeUndefined();
    }
    expect(pieces.reduce((n, p) => n + (p.body as Uint8Array).length, 0)).toBe(size);
  });

  it('reports a rejected upload as a server problem', async () => {
    const net = network([json({ access_token: 'T' }), json({}, 507)]);
    await expect(uploadBackup(onedrive, 'a.gstbk', bytes(10), net.f)).rejects.toMatchObject({
      kind: 'server',
    });
  });
});

/** Object storage against MinIO in a container: signed upload and download, keys under the organisation, refusals. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';
import { makeStorage, MAX_OBJECT_BYTES, type Storage } from '../src/storage/s3';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startMinio, startPostgres, type MinioStack, type PgStack } from './containers';

let pg: PgStack;
let minio: MinioStack;
let storage: Storage;
let t: TestApp;
let owner: Client;
let orgId: string;

beforeAll(async () => {
  [pg, minio] = await Promise.all([startPostgres(), startMinio()]);
  const cfg = loadConfig({
    DATABASE_URL: pg.adminUrl,
    S3_ENDPOINT: minio.endpoint,
    S3_ACCESS_KEY: minio.accessKey,
    S3_SECRET_KEY: minio.secretKey,
    S3_BUCKET: 'gstdesk-test',
    S3_SSE: 'none',
  });
  storage = makeStorage(cfg)!;
  await storage.ensureBucket();
  t = makeTestApp(pg, { storage });
  owner = await t.signIn('owner@example.com');
  orgId = (
    await owner.json<{ id: string }>('/v1/orgs', {
      method: 'POST',
      body: JSON.stringify({ name: 'Files Ltd' }),
    })
  ).body.id;
});
afterAll(async () => {
  await Promise.all([pg?.stop(), minio?.stop()]);
});

describe('files', () => {
  it('signs an upload, the bytes go straight to the store encrypted, and a signed download returns them', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 hello');
    const signed = await owner.json<{
      key: string;
      url: string;
      headers: Record<string, string>;
      expiresAt: number;
    }>(`/v1/orgs/${orgId}/files/sign-upload`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'attachments',
        name: 'bill-1.pdf',
        mime: 'application/pdf',
        sizeBytes: bytes.length,
      }),
    });
    expect(signed.status).toBe(200);
    expect(signed.body.key).toBe(`orgs/${orgId}/attachments/bill-1.pdf`);
    expect(signed.body.expiresAt).toBeGreaterThan(Date.now());
    const put = await fetch(signed.body.url, {
      method: 'PUT',
      headers: signed.body.headers,
      body: bytes,
    });
    expect(put.status).toBe(200);
    expect(await storage.exists(signed.body.key)).toMatchObject({
      sizeBytes: bytes.length,
      mime: 'application/pdf',
    });

    const down = await owner.json<{ url: string; sizeBytes: number; mime: string }>(
      `/v1/orgs/${orgId}/files/sign-download?key=${encodeURIComponent(signed.body.key)}&fileName=bill-1.pdf`,
    );
    expect(down.status).toBe(200);
    const got = await fetch(down.body.url);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('%PDF-1.4 hello');
    expect(got.headers.get('content-disposition')).toContain('bill-1.pdf');
  });

  it('refuses a wrong type, a huge file, a bad name, and a key outside the organisation', async () => {
    const mime = await owner.json<{ error: { code: string } }>(
      `/v1/orgs/${orgId}/files/sign-upload`,
      {
        method: 'POST',
        body: JSON.stringify({
          kind: 'attachments',
          name: 'x.exe',
          mime: 'application/x-msdownload',
          sizeBytes: 10,
        }),
      },
    );
    expect(mime.status).toBe(400);
    const big = await owner.json<{ error: { code: string } }>(
      `/v1/orgs/${orgId}/files/sign-upload`,
      {
        method: 'POST',
        body: JSON.stringify({
          kind: 'attachments',
          name: 'x.pdf',
          mime: 'application/pdf',
          sizeBytes: MAX_OBJECT_BYTES + 1,
        }),
      },
    );
    expect(big.status).toBe(400);
    const name = await owner.json<{ error: { code: string } }>(
      `/v1/orgs/${orgId}/files/sign-upload`,
      {
        method: 'POST',
        body: JSON.stringify({
          kind: 'attachments',
          name: '../etc/passwd',
          mime: 'application/pdf',
          sizeBytes: 10,
        }),
      },
    );
    expect(name.status).toBe(400);
    const elsewhere = await owner.json<{ error: { code: string } }>(
      `/v1/orgs/${orgId}/files/sign-download?key=${encodeURIComponent(`orgs/${crypto.randomUUID()}/attachments/bill-1.pdf`)}`,
    );
    expect(elsewhere.status).toBe(404);
    const missing = await owner.json<{ error: { code: string } }>(
      `/v1/orgs/${orgId}/files/sign-download?key=${encodeURIComponent(`orgs/${orgId}/attachments/nope.pdf`)}`,
    );
    expect(missing.status).toBe(404);
  });

  it('a viewer may download but not upload', async () => {
    const viewer = await t.signIn('viewer@example.com');
    const [u] = await pg.app.sql`SELECT id FROM auth_user WHERE email = 'viewer@example.com'`;
    await t.auth.api.addMember({
      body: { organizationId: orgId, userId: String(u!['id']), role: 'viewer' },
    });
    const up = await viewer.fetch(`/v1/orgs/${orgId}/files/sign-upload`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'attachments',
        name: 'y.pdf',
        mime: 'application/pdf',
        sizeBytes: 10,
      }),
    });
    expect(up.status).toBe(403);
    const down = await viewer.fetch(
      `/v1/orgs/${orgId}/files/sign-download?key=${encodeURIComponent(`orgs/${orgId}/attachments/bill-1.pdf`)}`,
    );
    expect(down.status).toBe(200);
  });
});

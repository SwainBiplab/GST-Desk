import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { BusinessRepo, createOrganisation } from './aggregates';
import { AuditRepo } from './aggregates';
import { BaseRepo, type Ctx } from './base';
import { LanDeviceRepo, type LanDeviceRow } from './lan-devices';

const dev = (over: Partial<LanDeviceRow> = {}): LanDeviceRow => ({
  id: crypto.randomUUID(),
  name: 'Counter 1',
  platform: 'Android',
  role: 'counter',
  tokenHash: 'a'.repeat(64),
  tokenIssuedAt: 1_000,
  prevTokenHash: null,
  prevValidUntil: 0,
  createdAt: 1_000,
  lastSeenAt: 1_000,
  revokedAt: null,
  ...over,
});

describe.each(DIALECTS)('paired devices (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let other: Ctx;
  let repo: LanDeviceRepo;

  async function tenant(name: string): Promise<Ctx> {
    const org = await createOrganisation(d, name);
    const base: Ctx = { orgId: org['id'], businessId: '', actor: 't', deviceId: 'desktop' };
    const biz = await new BusinessRepo(d).create(base, { legal_name: name, state_code: '27' });
    return { ...base, businessId: biz['id'] };
  }

  beforeAll(async () => {
    d = await openTestDb(dialect);
    ctx = await tenant('A');
    other = await tenant('B');
    repo = new LanDeviceRepo(d);
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('stores a paired device with the hash of its token, and finds it by that hash', async () => {
    const a = dev({ tokenHash: 'h1'.padEnd(64, '0') });
    await repo.save(ctx, a);
    // the time it was made is stamped by the repository
    const [stored] = await repo.devices(ctx);
    expect(stored).toEqual({ ...a, createdAt: stored!.createdAt });
    expect(await repo.findByHash(ctx, a.tokenHash, 5_000)).toEqual(stored);
    expect(await repo.findByHash(ctx, 'nope', 5_000)).toBeNull();
  });

  it('keeps the previous token for its grace and not after', async () => {
    const a = dev({
      tokenHash: 'new'.padEnd(64, '0'),
      prevTokenHash: 'old'.padEnd(64, '0'),
      prevValidUntil: 10_000,
    });
    await repo.save(ctx, a);
    expect((await repo.findByHash(ctx, a.prevTokenHash!, 9_999))?.id).toBe(a.id);
    expect(await repo.findByHash(ctx, a.prevTokenHash!, 10_001)).toBeNull();
  });

  it('records a revocation, a rename and a role change, each in the audit trail', async () => {
    const a = dev({ tokenHash: 'r1'.padEnd(64, '0') });
    await repo.save(ctx, a);
    await repo.save(ctx, { ...a, name: 'Counter 2' });
    await repo.save(ctx, { ...a, name: 'Counter 2', role: 'view' });
    await repo.save(ctx, { ...a, name: 'Counter 2', role: 'view', revokedAt: 9_000 });
    const now = (await repo.devices(ctx)).find((x) => x.id === a.id)!;
    expect(now).toMatchObject({ name: 'Counter 2', role: 'view', revokedAt: 9_000 });
    const trail = await new AuditRepo(d).forRow(ctx, 'devices', a.id);
    expect(trail.length).toBeGreaterThanOrEqual(4);
  });

  it('writes "last seen" at most once a minute, so a busy tablet does not fill the audit log', async () => {
    const a = dev({ tokenHash: 'ls'.padEnd(64, '0'), lastSeenAt: 100_000 });
    await repo.save(ctx, a);
    const count = async () => (await new AuditRepo(d).forRow(ctx, 'devices', a.id)).length;
    const before = await count();
    for (let i = 1; i <= 30; i++) await repo.save(ctx, { ...a, lastSeenAt: 100_000 + i * 1000 });
    expect(await count()).toBe(before); // thirty requests inside a minute: nothing written
    await repo.save(ctx, { ...a, lastSeenAt: 100_000 + 61_000 });
    expect(await count()).toBe(before + 1);
    expect((await repo.devices(ctx)).find((x) => x.id === a.id)!.lastSeenAt).toBe(161_000);
  });

  it('does not show another business its devices, or a sync device as a paired one', async () => {
    expect(await repo.devices(other)).toEqual([]);
    await new BaseRepo(d, 'devices').create(ctx, { name: 'Laptop', platform: 'Windows' } as never);
    expect((await repo.devices(ctx)).map((x) => x.name)).not.toContain('Laptop');
  });
});

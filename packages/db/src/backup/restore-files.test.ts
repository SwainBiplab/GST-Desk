import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { queryRows, type Database } from '../database';
import { migrate } from '../migrate';
import { openNodeSqlite, recoverRestore, restoreIntoFile, undoRestore } from '../node';
import { PartyRepo, createOrganisation, BusinessRepo } from '../repositories/aggregates';
import { seedDemo } from '../seed';

import { BackupError, TABLES, createBackup } from './index';

const dir = mkdtempSync(join(tmpdir(), 'gst-restore-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file briefly; the temp cleaner takes it */
  }
});

const open = async (file: string): Promise<Database> => openNodeSqlite(file);
const counts = async (file: string): Promise<Record<string, number>> => {
  const d = await open(file);
  try {
    const out: Record<string, number> = {};
    for (const t of TABLES) {
      const r = await queryRows(d, d.db, sql`SELECT count(*) AS c FROM ${sql.identifier(t.name)}`);
      out[t.name] = Number(r[0]!['c']);
    }
    return out;
  } finally {
    await d.close();
  }
};

/** A small book that is nothing like the seeded one, kept in a file. */
async function makeOldDatabase(file: string) {
  const d = await open(file);
  await migrate(d);
  const org = await createOrganisation(d, 'Old org');
  const base = { orgId: String(org['id']), businessId: '', actor: 't', deviceId: 'd' };
  const biz = await new BusinessRepo(d).create(base, {
    legal_name: 'Old Business',
    state_code: '27',
  });
  const ctx = { ...base, businessId: String(biz['id']) };
  for (let i = 0; i < 5; i++)
    await new PartyRepo(d).create(ctx, { type: 'customer', name: `Old ${i}`, state_code: '27' });
  await d.close();
}

describe('restoring over a database file', () => {
  let backup: Uint8Array;
  let backupFile: string;
  let seededCounts: Record<string, number>;

  beforeAll(async () => {
    const seededFile = join(dir, 'seeded.sqlite');
    const s = await open(seededFile);
    await migrate(s);
    await seedDemo(s, { documents: 150, parties: 20, items: 30 });
    backup = (await createBackup(s)).bytes;
    await s.close();
    seededCounts = await counts(seededFile);
    backupFile = join(dir, 'seeded.gstbk');
    writeFileSync(backupFile, backup);
  }, 120_000);

  it('swaps the restored database in, and keeps the old one aside', async () => {
    const file = join(dir, 'swap.sqlite');
    await makeOldDatabase(file);
    const before = await counts(file);
    expect(before['parties']).toBe(5);
    const r = await restoreIntoFile({ file, backup });
    expect(r.previous).toBe(`${file}.previous`);
    expect(await counts(file)).toEqual(seededCounts);
    expect(await counts(`${file}.previous`)).toEqual(before);
    expect(readdirSync(dir).filter((n) => n.includes('swap.sqlite.restoring'))).toEqual([]);
    // undoing it puts the old one back
    expect(await undoRestore(file)).toBe(true);
    expect(await counts(file)).toEqual(before);
  }, 120_000);

  it('creates the file when there was none', async () => {
    const file = join(dir, 'new.sqlite');
    const r = await restoreIntoFile({ file, backup });
    expect(r.previous).toBeNull();
    expect(await counts(file)).toEqual(seededCounts);
  }, 120_000);

  it('leaves the live database exactly as it was when the backup is bad', async () => {
    const file = join(dir, 'bad.sqlite');
    await makeOldDatabase(file);
    const before = await counts(file);
    await expect(
      restoreIntoFile({ file, backup: new Uint8Array([1, 2, 3, 4]) }),
    ).rejects.toBeInstanceOf(BackupError);
    expect(await counts(file)).toEqual(before);
    // a failure inside the restore is the same
    await expect(
      restoreIntoFile({
        file,
        backup,
        onBatch: (t) => {
          if (t === 'documents') throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(await counts(file)).toEqual(before);
    expect(readdirSync(dir).filter((n) => n.startsWith('bad.sqlite.restoring'))).toEqual([]);
  }, 120_000);

  describe('when the process is killed', () => {
    const kill = (file: string, when: string) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          join(import.meta.dirname, 'testing', 'restore-child.ts'),
          file,
          backupFile,
          when,
        ],
        {
          encoding: 'utf8',
          timeout: 120_000,
        },
      );

    it.each(['mid-rows', 'before-swap'])(
      '%s: the old database is intact and a retry works',
      async (when) => {
        const file = join(dir, `kill-${when}.sqlite`);
        await makeOldDatabase(file);
        const before = await counts(file);

        const child = kill(file, when);
        // it was stopped from outside, not finished
        expect(child.stdout).not.toContain('finished');
        expect(child.status === null || child.status !== 0).toBe(true);
        expect(await counts(file)).toEqual(before);

        // the next start tidies up the half-built file, and a retry succeeds
        const tidy = await recoverRestore(file);
        expect(tidy.restoredPrevious).toBe(false);
        expect(
          readdirSync(dir).filter((n) => n.startsWith(`kill-${when}.sqlite.restoring`)),
        ).toEqual([]);
        await restoreIntoFile({ file, backup });
        expect(await counts(file)).toEqual(seededCounts);
      },
      180_000,
    );

    it('between the two renames: nothing is lost, and the old database comes back', async () => {
      const file = join(dir, 'kill-between.sqlite');
      await makeOldDatabase(file);
      const before = await counts(file);
      const child = kill(file, 'between-renames');
      expect(child.stdout).not.toContain('finished');
      // the live name is empty for a moment: the old database is safe beside it
      expect(existsSync(file)).toBe(false);
      expect(await counts(`${file}.previous`)).toEqual(before);
      const tidy = await recoverRestore(file);
      expect(tidy.restoredPrevious).toBe(true);
      expect(await counts(file)).toEqual(before);
    }, 180_000);
  });
});

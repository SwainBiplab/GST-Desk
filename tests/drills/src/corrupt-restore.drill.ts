/**
 * Drill: back up, damage the database, restore.
 *
 * A seeded book is backed up and checked. Then the database file is damaged in the ways a failing disk
 * or a bad copy would: bytes overwritten in the middle, the file cut short, the header destroyed.
 * Each time the damage is confirmed (SQLite either refuses the file or its integrity check fails),
 * the backup is restored over the file, and the book that comes back is the book that was backed up:
 * every table has the same number of rows, a spot-checked document total is unchanged, and the
 * integrity and reference checks pass.
 */
import {
  copyFileSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TABLES, createBackup, migrate, queryRows, type Database } from '@gst/db';
import { openNodeSqlite, restoreIntoFile } from '@gst/db/node';
import { seedDemo } from '@gst/db/seed';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'gst-drill-corrupt-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file briefly */
  }
});

const counts = async (d: Database) => {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const r = await queryRows(d, d.db, sql`SELECT count(*) AS c FROM ${sql.identifier(t.name)}`);
    out[t.name] = Number(r[0]!['c']);
  }
  return out;
};

/** What SQLite says about a file: `ok`, or the reason it is not. */
async function verdict(file: string): Promise<string> {
  let d: Database | null = null;
  try {
    d = await openNodeSqlite(file);
    const r = await queryRows(d, d.db, sql`PRAGMA integrity_check`);
    return String(r[0]?.['integrity_check'] ?? 'no answer');
  } catch (e) {
    return `refused: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await d?.close().catch(() => undefined);
  }
}

describe('back up, damage the database, restore', () => {
  let good: string;
  let backup: Uint8Array;
  let expected: Record<string, number>;
  let totalBefore = 0;

  beforeAll(async () => {
    good = join(dir, 'good.sqlite');
    const d = await openNodeSqlite(good);
    await migrate(d);
    await seedDemo(d, { parties: 20, items: 30, documents: 150 });
    expected = await counts(d);
    totalBefore = Number(
      (
        await queryRows(
          d,
          d.db,
          sql`SELECT coalesce(sum(total_paise), 0) AS s FROM documents WHERE status = 'issued'`,
        )
      )[0]!['s'],
    );
    backup = (await createBackup(d)).bytes;
    await d.close();
  });

  const damage: [string, (file: string) => void][] = [
    [
      'bytes overwritten in the middle',
      (f) => {
        const fd = openSync(f, 'r+');
        const size = statSync(f).size;
        writeSync(fd, Buffer.alloc(8192, 0xff), 0, 8192, Math.floor(size / 2));
        closeSync(fd);
      },
    ],
    ['the file cut short', (f) => truncateSync(f, Math.floor(statSync(f).size / 3))],
    [
      'the header destroyed',
      (f) => {
        const fd = openSync(f, 'r+');
        writeSync(fd, Buffer.from('this is not a database file at all........'), 0, 40, 0);
        closeSync(fd);
      },
    ],
  ];

  it.each(damage)(
    '%s: the damage is real, and a restore brings the book back',
    async (name, hurt) => {
      const file = join(dir, `${name.replace(/\W+/g, '-')}.sqlite`);
      copyFileSync(good, file);
      expect(await verdict(file)).toBe('ok');
      hurt(file);
      expect(await verdict(file), 'the damage should be visible to SQLite').not.toBe('ok');

      await restoreIntoFile({ file, backup });

      expect(await verdict(file)).toBe('ok');
      const d = await openNodeSqlite(file);
      try {
        expect(await counts(d)).toEqual(expected);
        const total = Number(
          (
            await queryRows(
              d,
              d.db,
              sql`SELECT coalesce(sum(total_paise), 0) AS s FROM documents WHERE status = 'issued'`,
            )
          )[0]!['s'],
        );
        expect(total).toBe(totalBefore);
        expect((await queryRows(d, d.db, sql`PRAGMA foreign_key_check`)).length).toBe(0);
      } finally {
        await d.close();
      }
    },
  );

  it('the backup itself is checked: a corrupted backup is refused and the database is left alone', async () => {
    const file = join(dir, 'untouched.sqlite');
    copyFileSync(good, file);
    const before = readFileSync(file);
    const bad = new Uint8Array(backup);
    // flip a byte in the middle of the archive
    bad[Math.floor(bad.length / 2)] = bad[Math.floor(bad.length / 2)]! ^ 0xff;
    await expect(restoreIntoFile({ file, backup: bad })).rejects.toThrow();
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(await verdict(file)).toBe('ok');
  });
});

/**
 * Drill: power loss while documents are being issued.
 *
 * A child process issues invoices into a database file without stopping. The parent kills it
 * (SIGKILL: no clean shutdown, no chance to roll back) at several moments, some timed by how many
 * invoices were done and some at a random instant, then opens the file again and checks the book is
 * sound: SQLite's own integrity check, no broken references, no invoice without a number, no number
 * given twice, none without its ledger entries, and the series counter agrees with what was issued.
 * An invoice that was cut off must be wholly there or wholly not there.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SOUND, open, soundness } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'gst-drill-power-'));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold a file briefly */
  }
});

/** Start the child, let it run until `stop` says so, kill it hard, and say how many invoices it reported. */
function runAndKill(
  file: string,
  stop: (issued: number, sinceReady: number) => boolean,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(import.meta.dirname, 'issue-child.ts'), file],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    let issued = 0;
    let readyAt = 0;
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      child.kill('SIGKILL');
    };
    child.stdout.on('data', (b: Buffer) => {
      for (const l of b.toString().split('\n')) {
        if (l.trim() === 'ready') readyAt = Date.now();
        const m = /^issued (\d+)/.exec(l.trim());
        if (m) issued = Number(m[1]);
      }
      if (readyAt && stop(issued, Date.now() - readyAt)) kill();
    });
    child.on('error', reject);
    child.on('exit', () => resolve(issued));
    // a child that never gets going must not hang the drill
    setTimeout(kill, 90_000).unref();
  });
}

describe('power loss while issuing', () => {
  const cases: [string, (issued: number, ms: number) => boolean][] = [
    ['after the third invoice', (n) => n >= 3],
    ['after the tenth invoice', (n) => n >= 10],
    [
      'at a random moment, soon after starting',
      (_n, ms) => ms >= 50 + Math.floor(Math.random() * 400),
    ],
    ['at another random moment, later', (_n, ms) => ms >= 600 + Math.floor(Math.random() * 900)],
  ];

  it.each(cases)('killed %s: the book is sound and nothing is half-issued', async (name, stop) => {
    const file = join(dir, `${name.replace(/\W+/g, '-')}.sqlite`);
    const reported = await runAndKill(file, stop);

    const d = await open(file);
    try {
      const s = await soundness(d);
      const { issued, ...rest } = s;
      expect(rest).toEqual(SOUND);
      // every invoice the child reported as finished is there; the one it was cut off in is either there whole or not at all
      expect(issued).toBeGreaterThanOrEqual(reported);
      expect(issued).toBeLessThanOrEqual(reported + 1);
    } finally {
      await d.close();
    }
  });

  it('a book that was cut off can be carried on with: the next invoice gets the next number', async () => {
    const file = join(dir, 'carry-on.sqlite');
    await runAndKill(file, (n) => n >= 4);
    const { openBook, issueOne } = await import('./helpers');
    const b = await openBook(file);
    try {
      const before = (await soundness(b.d)).issued;
      const number = await issueOne(b);
      expect(number).not.toBe('');
      const after = await soundness(b.d);
      expect(after.issued).toBe(before + 1);
      const { issued, ...rest } = after;
      expect(issued).toBe(before + 1);
      expect(rest).toEqual(SOUND);
    } finally {
      await b.d.close();
    }
  });
});

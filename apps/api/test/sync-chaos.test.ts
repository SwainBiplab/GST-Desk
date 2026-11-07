/**
 * The chaos test (prompt 41): two devices work offline on one business with scripted random operations,
 * then reconnect in a random order. After every run:
 *  - every issued or cancelled document has a real number, and no two share one;
 *  - both devices and the server hold the same rows (ids and versions) for the business;
 *  - nothing a device did is lost: every uploaded transaction was applied, or became a conflict that sits
 *    in the inbox with both versions; none was refused.
 *
 * `CHAOS_RUNS` sets how many seeded runs (default 5 in the normal suite; `CHAOS_RUNS=100` for the
 * acceptance run). Each run uses a new business in the same organisation, against the real PowerSync
 * service, with two long-lived devices.
 */
import { DocumentFlowRepo, PartyRepo } from '@gst/db';
import { ensureRanges } from '@gst/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestApp, type Client, type TestApp } from './app-helper';
import { startSyncStack, type SyncStack } from './containers';
import {
  closeDevice,
  invoiceDraft,
  makeSynced,
  openDevice,
  serverRows,
  settled,
  toRows,
  until,
  type Device,
} from './sync-helper';

const RUNS = Number(process.env['CHAOS_RUNS'] ?? 5);
const OPS = Number(process.env['CHAOS_OPS'] ?? 24);

let stack: SyncStack;
let t: TestApp;
let owner: Client;
let orgId: string;
let userId: string;
let a: Device;
let b: Device;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

beforeAll(async () => {
  stack = await startSyncStack();
  t = makeTestApp(stack, {
    env: { POWERSYNC_URL: stack.powersyncUrl, POWERSYNC_JWT_SECRET: stack.jwtSecret },
  });
  owner = await t.signIn('chaos@example.com');
  orgId = (
    await owner.json<{ id: string }>('/v1/orgs', {
      method: 'POST',
      body: JSON.stringify({ name: 'Chaos Co' }),
    })
  ).body.id;
  userId = (await owner.json<{ user: { id: string } }>('/v1/me')).body.user.id;
  // the devices exist before any business; each run's business arrives by the stream
  a = await openDevice(t, owner, orgId, '', userId, 'chaos-a');
  b = await openDevice(t, owner, orgId, '', userId, 'chaos-b');
  await a.book.connect();
  await b.book.connect();
}, 300_000);

afterAll(async () => {
  for (const d of [a, b]) if (d) await closeDevice(d);
  await stack?.stop();
});

const TABLES = [
  'parties',
  'documents',
  'document_lines',
  'payments',
  'ledger_entries',
  'stock_movements',
  'number_reservations',
  'review_items',
];

async function snapshot(dev: Device, businessId: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const tbl of TABLES) {
    const rows = await dev.book.ps.getAll<{ id: string; version: number }>(
      `SELECT id, version FROM ${tbl} WHERE business_id = ? ORDER BY id`,
      [businessId],
    );
    out[tbl] = rows.map((r) => `${r.id}@${r.version}`);
  }
  return out;
}

async function serverSnapshot(businessId: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const tbl of TABLES) {
    const rows = await serverRows(
      stack,
      orgId,
      `SELECT id, version FROM ${tbl} WHERE business_id = $1 ORDER BY id`,
      [businessId],
    );
    out[tbl] = rows.map((r) => `${r['id']}@${r['version']}`);
  }
  return out;
}

/** One random operation on a device; anything the repositories refuse locally is simply skipped. */
async function randomOp(dev: Device, r: () => number, parties: string[]): Promise<string> {
  const flow = new DocumentFlowRepo(dev.book.database);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const drafts = await dev.book.ps.getAll<{ id: string; version: number }>(
    "SELECT id, version FROM documents WHERE business_id = ? AND status = 'draft' AND deleted_at IS NULL",
    [dev.ctx.businessId],
  );
  const issued = await dev.book.ps.getAll<{ id: string; version: number }>(
    "SELECT id, version FROM documents WHERE business_id = ? AND status = 'issued'",
    [dev.ctx.businessId],
  );
  const x = r();
  try {
    if (x < 0.08) {
      const p = await new PartyRepo(dev.book.database).create(dev.ctx, {
        type: 'customer',
        name: `P${Math.floor(r() * 1e6)}`,
        state_code: '27',
      });
      parties.push(String(p['id']));
      return 'party+';
    }
    if (x < 0.28) {
      const id = pick(parties);
      const cur = await new PartyRepo(dev.book.database).get(dev.ctx, id);
      if (!cur) return 'skip';
      const patch =
        r() < 0.5
          ? { phone: `98${String(Math.floor(r() * 1e8)).padStart(8, '0')}` }
          : { notes: `note ${Math.floor(r() * 1e4)}` };
      await new PartyRepo(dev.book.database).update(dev.ctx, id, patch, cur['version']);
      return 'party~';
    }
    if (x < 0.38) {
      await flow.saveDraft(
        dev.ctx,
        toRows(
          invoiceDraft(
            pick(parties),
            'Customer',
            '2026-07-01',
            BigInt(1000 + Math.floor(r() * 50_000)),
          ),
        ),
      );
      return 'draft+';
    }
    if (x < 0.62 && drafts.length) {
      const d = pick(drafts);
      const cur = await flow.load(dev.ctx, d.id);
      if (!cur) return 'skip';
      await flow.saveDraft(dev.ctx, {
        id: d.id,
        version: Number(cur.document['version']),
        ...toRows(
          invoiceDraft(
            String(cur.document['party_id']),
            'Customer',
            '2026-07-01',
            BigInt(1000 + Math.floor(r() * 50_000)),
            r() < 0.5 ? 'urgent' : '',
          ),
        ),
      });
      return 'draft~';
    }
    if (x < 0.8 && drafts.length) {
      const d = pick(drafts);
      await flow.issueDraft(dev.ctx, d.id, d.version);
      return 'issue';
    }
    if (x < 0.93 && issued.length) {
      const d = pick(issued);
      await flow.cancelDocument(dev.ctx, d.id, d.version, 'chaos test');
      return 'cancel';
    }
    if (drafts.length) {
      const d = pick(drafts);
      await flow.discardDraft(dev.ctx, d.id, d.version);
      return 'discard';
    }
    return 'skip';
  } catch {
    return 'refused-locally';
  }
}

describe(`chaos: ${RUNS} runs of two devices offline`, () => {
  it(
    'converges with real, unique numbers and nothing lost',
    async () => {
      const summary: Record<string, number> = {};
      for (let run = 0; run < RUNS; run++) {
        const r = rng(20261107 + run * 7919);
        const businessId = (
          await owner.json<{ id: string }>(`/v1/orgs/${orgId}/businesses`, {
            method: 'POST',
            body: JSON.stringify({ legalName: `Chaos ${run}`, stateCode: '27' }),
          })
        ).body.id;
        await makeSynced(stack, { orgId, businessId, actor: userId, deviceId: 'server' });
        for (const d of [a, b]) d.ctx = { ...d.ctx, businessId };
        await until(
          async () =>
            !!(await a.book.ps.getOptional('SELECT id FROM businesses WHERE id = ?', [
              businessId,
            ])) &&
            !!(await b.book.ps.getOptional('SELECT id FROM businesses WHERE id = ?', [businessId])),
          'the business on both devices',
        );
        // a couple of shared customers, and a small block of numbers each (so blocks run out)
        const parties: string[] = [];
        for (let i = 0; i < 2; i++)
          parties.push(
            String(
              (
                await new PartyRepo(a.book.database).create(a.ctx, {
                  type: 'customer',
                  name: `Shared ${i}`,
                  state_code: '27',
                })
              )['id'],
            ),
          );
        // and shared drafts both devices will fight over, plus one issued document either may cancel
        const flowA = new DocumentFlowRepo(a.book.database);
        for (let i = 0; i < 3; i++)
          await flowA.saveDraft(
            a.ctx,
            toRows(invoiceDraft(parties[i % 2]!, 'Customer', '2026-07-01', BigInt(5000 + i))),
          );
        for (const d of [a, b])
          await ensureRanges(d.book.database, d.ctx, d.book.connector, '2026-07-01', {
            low: 2,
            size: 2 + Math.floor(r() * 3),
            types: ['tax_invoice'],
          });
        await settled(a);
        await settled(b);
        await until(
          async () =>
            Number(
              (
                await b.book.ps.get<{ n: number }>(
                  'SELECT count(*) AS n FROM parties WHERE business_id = ?',
                  [businessId],
                )
              ).n,
            ) >= 2,
          'shared parties on b',
        );
        await until(
          async () =>
            Number(
              (
                await b.book.ps.get<{ n: number }>(
                  "SELECT count(*) AS n FROM documents WHERE business_id = ? AND status = 'draft'",
                  [businessId],
                )
              ).n,
            ) >= 3,
          'shared drafts on b',
        );
        await until(async () => {
          for (const d of [a, b])
            if (
              !(await d.book.ps.getOptional(
                'SELECT id FROM number_reservations WHERE business_id = ? AND device_id = ?',
                [businessId, d.deviceId],
              ))
            )
              return false;
          return true;
        }, 'ranges on both devices');

        // offline: interleaved random work
        await a.book.disconnect();
        await b.book.disconnect();
        const before = {
          a: await a.book.ps.get<{ n: number }>('SELECT count(*) AS n FROM sync_outcomes'),
          b: await b.book.ps.get<{ n: number }>('SELECT count(*) AS n FROM sync_outcomes'),
        };
        const pa = [...parties];
        const pb = [...parties];
        for (let i = 0; i < OPS; i++) {
          // each device picks customers it has: its own new ones and the shared ones (a screen offers nothing else)
          const onA = r() < 0.5;
          const op = await randomOp(onA ? a : b, r, onA ? pa : pb);
          summary[op] = (summary[op] ?? 0) + 1;
        }

        // back online in a random order
        const order = r() < 0.5 ? [a, b] : [b, a];
        for (const d of order) await d.book.connect();
        for (let pass = 0; pass < 2; pass++) for (const d of order) await settled(d);

        // 1. numbers: real and unique
        const docs = await serverRows(
          stack,
          orgId,
          "SELECT type, number FROM documents WHERE business_id = $1 AND status <> 'draft' AND deleted_at IS NULL",
          [businessId],
        );
        expect(docs.filter((d) => String(d['number']).startsWith('PROV-'))).toEqual([]);
        const keys = docs.map((d) => `${d['type']}:${d['number']}`);
        expect(new Set(keys).size).toBe(keys.length);

        // 2. convergence: both devices hold exactly what the server holds
        const server = await serverSnapshot(businessId);
        for (const d of [a, b]) {
          await until(
            async () => JSON.stringify(await snapshot(d, businessId)) === JSON.stringify(server),
            `${d === a ? 'a' : 'b'} to match the server (run ${run})`,
            90_000,
          );
        }

        // 3. nothing lost: every upload applied or became a conflict in the inbox; none refused
        for (const [d, n0] of [
          [a, before.a.n],
          [b, before.b.n],
        ] as const) {
          const outs = await d.book.ps.getAll<{
            outcome: string;
            review_item_id: string | null;
            reason: string | null;
          }>('SELECT outcome, review_item_id, reason FROM sync_outcomes LIMIT -1 OFFSET ?', [n0]);
          const refused = outs.filter((o) => o.outcome === 'rejected');
          expect({ run, refused }).toEqual({ run, refused: [] });
          for (const o of outs.filter((x) => x.outcome === 'conflict')) {
            const [item] = await serverRows(
              stack,
              orgId,
              "SELECT kind, suggestion_json ? 'mine' AS has_mine FROM review_items WHERE id = $1",
              [o.review_item_id],
            );
            expect(item).toMatchObject({ kind: 'sync_conflict', has_mine: true });
          }
          for (const o of outs)
            summary[`outcome:${o.outcome}`] = (summary[`outcome:${o.outcome}`] ?? 0) + 1;
        }
      }
      console.log(`CHAOS ${RUNS} runs x ${OPS} ops:`, JSON.stringify(summary));
    },
    RUNS * 120_000 + 60_000,
  );
});

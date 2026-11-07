/**
 * Two tablets and a desktop, in one process: the real bridge, the real repositories on a real database,
 * and a client whose `fetch` goes straight to the bridge. It proves the rules and the arithmetic; it does
 * not prove the network (that is the Rust server's tests, and a real tablet on a real Wi-Fi).
 */
import {
  BusinessRepo,
  ItemRepo,
  PartyRepo,
  createOrganisation,
  migrate,
  queryRows,
  runInTx,
  type Ctx,
  type Database,
} from '@gst/db';
import { openSqlite } from '@gst/db/node';
import { draftToRows, emptyDraft, emptyDraftLine, type DraftDocument } from '@gst/domain';
import { LanBridge, TOKEN_ROTATE_AFTER_MS, type Role } from '@gst/lan';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { lanMethods } from './methods';
import { RemoteClient, RemoteError, type TokenStore } from './remote-client';
import { DbDeviceStore } from './store';

let d: Database;
let ctx: Ctx;
let bridge: LanBridge;
let now = Date.UTC(2026, 4, 10, 10, 0, 0);
let partyId: string;
let itemId: string;

beforeAll(async () => {
  d = await openSqlite();
  await migrate(d);
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'desktop', deviceId: 'desk' };
  const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
  ctx = { ...base, businessId: biz['id'] };
  partyId = (
    await new PartyRepo(d).create(ctx, {
      type: 'customer',
      name: 'Sharma',
      state_code: '27',
      country: 'India',
    } as never)
  )['id'] as string;
  itemId = (
    await new ItemRepo(d).create(ctx, {
      kind: 'goods',
      name: 'Cement bag',
      hsn: '2523',
      gst_rate_bp: 1800,
      sale_rate_paise: 35000,
      track_stock: true,
      opening_stock_micros: 100_000_000,
      opening_stock_value_paise: 3_000_000,
    } as never)
  )['id'] as string;
  bridge = new LanBridge({
    store: new DbDeviceStore(d, ctx),
    methods: lanMethods(d, ctx, { inventoryEnabled: () => true }),
    clock: () => now,
    enabled: () => true,
  });
}, 60_000);
afterAll(async () => {
  await d.close();
});

function memoryTokens(): TokenStore & { value: string | null } {
  const t = {
    value: null as string | null,
    get: () => t.value,
    set: (v: string | null) => {
      t.value = v;
    },
  };
  return t;
}

/** A client whose requests go straight into the bridge, from its own address. */
function tablet(ip: string) {
  const tokens = memoryTokens();
  const fetcher = (async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string> | undefined)?.['Authorization'];
    const r = await bridge.handle({
      route: url.endsWith('/pair') ? 'pair' : 'rpc',
      ip,
      token: auth?.replace('Bearer ', ''),
      body: String(init.body),
    });
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;
  return { tokens, client: new RemoteClient({ fetch: fetcher, tokens }) };
}

async function pairTablet(name: string, role: Role, ip: string) {
  const t = tablet(ip);
  const offer = bridge.startPairing(role);
  const r = await t.client.pair(offer.code, name, 'Android');
  return { ...t, ...r };
}

const invoice = (qty = 1_000_000n): DraftDocument => ({
  ...emptyDraft('tax_invoice', '2026-05-10', { supplierState: '27' }),
  partyId,
  partyName: 'Sharma',
  partyState: '27',
  lines: [
    {
      ...emptyDraftLine('k1'),
      itemId,
      description: 'Cement bag',
      hsn: '2523',
      qtyMicros: qty,
      ratePaise: 35000n,
      gstRateBp: 1800,
    },
  ],
});
const rowsOf = (dr: DraftDocument) => {
  const r = draftToRows(dr);
  return { doc: r.doc, lines: r.lines };
};

async function stock(): Promise<number> {
  const rows = await runInTx(d, ctx, (tx) =>
    queryRows(
      d,
      tx,
      sql`SELECT coalesce(sum(qty_micros), 0) AS q FROM stock_movements WHERE business_id = ${ctx.businessId} AND item_id = ${itemId}`,
    ),
  );
  return Number(rows[0]!['q']) / 1_000_000;
}

describe('two tablets billing at once', () => {
  it('produce sequential numbers with none missing or repeated, and the right stock', async () => {
    const one = await pairTablet('Counter 1', 'counter', '10.0.0.11');
    const two = await pairTablet('Counter 2', 'counter', '10.0.0.12');
    const before = await stock();
    expect(before).toBe(100);

    const sell = async (t: { client: RemoteClient }, n: number) => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const saved = await t.client.call<{ document: { id: string; version: number } }>(
          'documents.saveDraft',
          rowsOf(invoice()),
        );
        const issued = await t.client.call<{ document: { number: string } }>('documents.issue', {
          id: saved.document.id,
          version: saved.document.version,
        });
        out.push(issued.document.number);
      }
      return out;
    };
    const [a, b] = await Promise.all([sell(one, 10), sell(two, 10)]);
    const all = [...a, ...b];
    expect(new Set(all).size).toBe(20);
    const seq = all.map((x) => Number(x.split('/').pop())).sort((x, y) => x - y);
    expect(seq).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await stock()).toBe(80);
    // each tablet's own numbers rise: it never sees a number go backwards
    for (const mine of [a, b]) {
      const n = mine.map((x) => Number(x.split('/').pop()));
      expect(n).toEqual([...n].sort((x, y) => x - y));
    }
  }, 60_000);
});

describe('what a device may do', () => {
  it('lets a view device look and refuses it a sale, with the reason', async () => {
    const v = await pairTablet('Manager phone', 'view', '10.0.0.21');
    const parties = await v.client.call<{ name: string }[]>('parties.list');
    expect(parties.map((p) => p.name)).toContain('Sharma');
    await expect(v.client.call('documents.saveDraft', rowsOf(invoice()))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(v.client.call('parties.create', { name: 'X' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('lets a counter bill but not cancel, and only a full device cancel', async () => {
    const c = await pairTablet('Counter', 'counter', '10.0.0.31');
    const f = await pairTablet('Owner tablet', 'full', '10.0.0.32');
    const saved = await c.client.call<{ document: { id: string; version: number } }>(
      'documents.saveDraft',
      rowsOf(invoice()),
    );
    const issued = await c.client.call<{ document: { id: string; version: number } }>(
      'documents.issue',
      saved.document,
    );
    await expect(
      c.client.call('documents.cancel', { ...issued.document, reason: 'mistake' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const done = await f.client.call<{ document: { status: string } }>('documents.cancel', {
      ...issued.document,
      reason: 'wrong party',
    });
    expect(done.document.status).toBe('cancelled');
  });

  it('refuses a document whose totals do not add up, so a tampered client cannot write its own money', async () => {
    const t = await pairTablet('Counter', 'counter', '10.0.0.41');
    const r = rowsOf(invoice());
    const tampered = { doc: { ...r.doc, total_paise: 1 }, lines: r.lines };
    await expect(t.client.call('documents.saveDraft', tampered)).rejects.toThrow(/totals/);
  });

  it('creates a party from a short list of fields and ignores the rest', async () => {
    const t = await pairTablet('Counter', 'counter', '10.0.0.51');
    const p = await t.client.call<Record<string, unknown>>('parties.create', {
      name: 'Walk-in Co',
      phone: '9876543210',
      state_code: '27',
      org_id: 'x',
      credit_limit_paise: 99_999_999,
    });
    expect(p['name']).toBe('Walk-in Co');
    expect(p['credit_limit_paise']).toBe(0);
    expect(p['org_id']).toBeUndefined();
    await expect(t.client.call('parties.create', { name: '' })).rejects.toThrow(/name/i);
  });

  it('sends rows without the columns a tablet has no use for', async () => {
    const t = await pairTablet('Counter', 'view', '10.0.0.52');
    const biz = await t.client.call<Record<string, unknown>>('business.get');
    expect(biz['legal_name']).toBe('Demo');
    expect(biz).not.toHaveProperty('org_id');
    expect(biz).not.toHaveProperty('created_by');
  });
});

describe('two tablets on one document', () => {
  it('the second is told who has it, can take over, and the first learns it lost', async () => {
    const one = await pairTablet('Counter 1', 'counter', '10.0.0.61');
    const two = await pairTablet('Counter 2', 'counter', '10.0.0.62');
    const saved = await one.client.call<{ document: { id: string; version: number } }>(
      'documents.saveDraft',
      rowsOf(invoice()),
    );
    const id = saved.document.id;
    // counter 1 saves again (it holds the lock), counter 2 is turned away with a name
    await one.client.call('documents.saveDraft', { id, ...rowsOf({ ...invoice(2_000_000n) }) });
    const blocked = await two.client
      .call('documents.saveDraft', { id, ...rowsOf(invoice()) })
      .catch((e: unknown) => e as RemoteError);
    expect(blocked).toBeInstanceOf(RemoteError);
    expect(blocked).toMatchObject({
      code: 'locked',
      status: 409,
      message: 'Being edited on Counter 1.',
    });

    const lost: string[] = [];
    const stop = one.client.holdLock(`doc:${id}`, (e) => lost.push(e.message), 10);
    await two.client.call('lock.takeOver', { resource: `doc:${id}` });
    await new Promise((r) => setTimeout(r, 60));
    expect(lost[0]).toBe('Taken over by Counter 2.');
    stop();
  });
});

describe('a device that is removed, and a token that ages', () => {
  it('stops working at once when revoked, and forgets its token', async () => {
    const t = await pairTablet('Lost tablet', 'counter', '10.0.0.71');
    await t.client.call('whoami');
    expect(await bridge.revoke(t.deviceId)).toBe(true);
    await expect(t.client.call('whoami')).rejects.toMatchObject({ code: 'revoked' });
    expect(t.tokens.value).toBeNull();
    await expect(t.client.call('whoami')).rejects.toMatchObject({ code: 'no_token' });
  });

  it('is replaced after 30 days without the person doing anything', async () => {
    const t = await pairTablet('Old tablet', 'view', '10.0.0.81');
    const first = t.tokens.value;
    now += TOKEN_ROTATE_AFTER_MS + 1000;
    await t.client.call('whoami');
    expect(t.tokens.value).not.toBe(first);
    await expect(t.client.call('whoami')).resolves.toBeTruthy();
  });
});

/** Devices for the sync tests: real PowerSync clients over Node's SQLite, uploading through the app in process. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DocumentFlowRepo, NumberingRepo, PartyRepo, type Ctx } from '@gst/db';
import { draftToRows, emptyDraft, emptyDraftLine, type DraftDocument } from '@gst/domain';
import { openSyncedBook, type SyncedBook } from '@gst/sync/node';

import type { Client, TestApp } from './app-helper';
import type { SyncStack } from './containers';

export interface Device {
  book: SyncedBook;
  ctx: Ctx;
  deviceId: string;
  dir: string;
}

export async function openDevice(
  t: TestApp,
  who: Client,
  orgId: string,
  businessId: string,
  userId: string,
  name: string,
): Promise<Device> {
  const dir = mkdtempSync(join(tmpdir(), `gst-sync-${name}-`));
  const deviceId = crypto.randomUUID();
  const book = await openSyncedBook({
    dir,
    identity: {
      apiUrl: 'http://api.test',
      apiToken: who.token,
      orgId,
      deviceId,
      deviceName: name,
      platform: 'test',
    },
    fetchFn: async (url, init) => t.app.request(url.replace('http://api.test', ''), init),
  });
  return { book, deviceId, dir, ctx: { orgId, businessId, actor: userId, deviceId } };
}

export async function closeDevice(d: Device): Promise<void> {
  await d.book.disconnect().catch(() => undefined);
  await d.book.close().catch(() => undefined);
  rmSync(d.dir, { recursive: true, force: true });
}

export async function until(fn: () => Promise<boolean>, what: string, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  let n = 0;
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    if (process.env['SYNC_DEBUG'] && ++n % 30 === 0) console.log('waiting for', what);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Connected, nothing waiting to upload, and the local copy has caught up with the last checkpoint. */
export async function settled(d: Device): Promise<void> {
  await until(async () => (await d.book.pending()) === 0, `${d.deviceId} to upload`).catch(
    (e: Error) => {
      throw new Error(
        `${e.message}; last upload error: ${d.book.connector.lastError?.message ?? 'none'}`,
      );
    },
  );
  await until(async () => {
    const s = d.book.ps.currentStatus;
    return (
      !!s.connected && !!s.hasSynced && !s.dataFlowStatus.downloading && !s.dataFlowStatus.uploading
    );
  }, `${d.deviceId} to download`);
}

/** The server says the business is synced: devices take numbers from ranges. */
export async function makeSynced(stack: SyncStack, ctx: Ctx): Promise<void> {
  await new NumberingRepo(stack.app).setMode(ctx, 'synced');
}

/** Wait until a query on a device returns what the server has. */
export async function converge(d: Device, sql: string, want: unknown, what: string): Promise<void> {
  await until(
    async () => JSON.stringify(await d.book.ps.getAll(sql)) === JSON.stringify(want),
    what,
  );
}

let lineKey = 0;
export function invoiceDraft(
  partyId: string,
  partyName: string,
  date: string,
  ratePaise: bigint,
  notes = '',
): DraftDocument {
  return {
    ...emptyDraft('tax_invoice', date, { supplierState: '27' }),
    partyId,
    partyName,
    partyState: '27',
    placeOfSupply: '27',
    notes,
    lines: [
      {
        ...emptyDraftLine(`k${lineKey++}`),
        description: 'Cement',
        qtyMicros: 2_000_000n,
        ratePaise,
        gstRateBp: 2800,
      },
    ],
  };
}

export const toRows = (dr: DraftDocument) => {
  const r = draftToRows(dr);
  return {
    doc: r.doc as unknown as Record<string, unknown>,
    lines: r.lines as unknown as Record<string, unknown>[],
  };
};

/** Save a draft and issue it on a device, as the editor would. */
export async function issueOn(
  dev: Device,
  dr: DraftDocument,
): Promise<{ id: string; number: string }> {
  const flow = new DocumentFlowRepo(dev.book.database);
  const saved = await flow.saveDraft(dev.ctx, toRows(dr));
  const r = await flow.issueDraft(
    dev.ctx,
    String(saved.document['id']),
    Number(saved.document['version']),
  );
  return { id: String(r.document['id']), number: String(r.document['number']) };
}

export async function partyOn(dev: Device, name: string): Promise<string> {
  const p = await new PartyRepo(dev.book.database).create(dev.ctx, {
    type: 'customer',
    name,
    state_code: '27',
  });
  return String(p['id']);
}

/** Rows of a table on the server for the organisation (as the app role, so RLS applies). */
export async function serverRows(
  stack: SyncStack,
  orgId: string,
  query: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return stack.app.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return tx.unsafe(query, params as never[]);
  }) as Promise<Record<string, unknown>[]>;
}

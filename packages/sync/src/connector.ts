/**
 * The device's side of the API: a token for the PowerSync service, uploads of queued transactions, and
 * number ranges. Every outcome the server gives (applied, conflict, rejected) is kept in a local table
 * the status sheet reads, so nothing a person did disappears silently.
 */
import { isUploadableSetting } from '@gst/db';

export interface SyncIdentity {
  apiUrl: string;
  /** The person's bearer token for the API. */
  apiToken: string;
  orgId: string;
  deviceId: string;
  deviceName: string;
  platform: string;
}

export interface CrudEntryLike {
  op: string;
  table: string;
  id: string;
  opData?: Record<string, unknown> | undefined;
  previousValues?: Record<string, unknown> | undefined;
}

export interface CrudTransactionLike {
  transactionId?: number | undefined;
  crud: CrudEntryLike[];
  complete(): Promise<void>;
}

export interface UploadDb {
  getNextCrudTransaction(): Promise<CrudTransactionLike | null>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
}

export interface TxResult {
  txId: number;
  outcome: 'applied' | 'duplicate' | 'conflict' | 'rejected';
  reason?: string;
  reviewItemId?: string;
  renumbered?: { id: string; from: string; to: string }[];
}

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

export const OUTCOMES_TABLE = 'sync_outcomes';
export const OUTCOMES_DDL = `CREATE TABLE IF NOT EXISTS ${OUTCOMES_TABLE} (
  tx_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  review_item_id TEXT,
  ops INTEGER NOT NULL,
  at INTEGER NOT NULL
)`;

export class SyncConnector {
  /** Called after every upload with the server's answers. */
  onResults: ((r: TxResult[]) => void) | null = null;
  /** The last upload failure (network, server), for the status sheet; cleared by a good upload. */
  lastError: { at: number; message: string } | null = null;

  constructor(
    readonly id: SyncIdentity,
    private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response> = (u, i) =>
      fetch(u, i),
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.id.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.id.apiToken}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok)
      throw new SyncHttpError(res.status, `${path}: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async fetchCredentials(): Promise<{ endpoint: string; token: string; expiresAt: Date }> {
    const r = await this.post<{
      endpoint: string;
      token: string;
      deviceId: string;
      expiresAt: number;
    }>('/v1/sync/token', {
      orgId: this.id.orgId,
      deviceId: this.id.deviceId,
      deviceName: this.id.deviceName,
      platform: this.id.platform,
    });
    return { endpoint: r.endpoint, token: r.token, expiresAt: new Date(r.expiresAt) };
  }

  /**
   * Upload every queued transaction, a few at a time. A transaction is completed (taken off the queue)
   * once the server has given it an outcome; a network or server failure throws so PowerSync tries again.
   */
  async uploadData(db: UploadDb): Promise<void> {
    try {
      await this.uploadAll(db);
      this.lastError = null;
    } catch (e) {
      this.lastError = { at: Date.now(), message: e instanceof Error ? e.message : String(e) };
      throw e;
    }
  }

  private async uploadAll(db: UploadDb): Promise<void> {
    for (;;) {
      const tx = await db.getNextCrudTransaction();
      if (!tx) return;
      const ops = [];
      for (const e of tx.crud) {
        if (e.table === 'settings' && !(await this.uploadableSetting(db, e))) continue;
        ops.push({
          op: e.op,
          table: e.table,
          id: e.id,
          ...(e.opData ? { data: e.opData } : {}),
          ...(e.previousValues ? { previous: e.previousValues } : {}),
        });
      }
      if (!ops.length) {
        await tx.complete();
        continue;
      }
      const txId = tx.transactionId ?? Date.now();
      const { results } = await this.post<{ results: TxResult[] }>('/v1/sync/write', {
        orgId: this.id.orgId,
        deviceId: this.id.deviceId,
        transactions: [{ txId, ops }],
      });
      for (const r of results)
        await db.execute(
          `INSERT INTO ${OUTCOMES_TABLE} (tx_id, outcome, reason, review_item_id, ops, at) VALUES (?, ?, ?, ?, ?, ?)`,
          [r.txId, r.outcome, r.reason ?? null, r.reviewItemId ?? null, ops.length, Date.now()],
        );
      this.onResults?.(results);
      await tx.complete();
    }
  }

  private async uploadableSetting(db: UploadDb, e: CrudEntryLike): Promise<boolean> {
    const key =
      (e.opData?.['key'] as string | undefined) ??
      (await db.getOptional<{ key: string }>('SELECT key FROM settings WHERE id = ?', [e.id]))
        ?.key ??
      '';
    return isUploadableSetting(key);
  }

  reserveRange(body: {
    businessId: string;
    seriesKey?: string;
    documentType?: string;
    date: string;
    size?: number;
  }): Promise<{ id: string; from: number; to: number }> {
    return this.post('/v1/sync/ranges', {
      orgId: this.id.orgId,
      deviceId: this.id.deviceId,
      ...body,
    });
  }
}

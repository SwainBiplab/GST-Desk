/**
 * Tablets and phones paired to this computer (prompt 35). They live in the `devices` table with kind
 * `lan`; only the SHA-256 of each token is kept. Every change is audited by the base repository, except
 * that "last seen" is written at most once a minute, so a busy tablet does not fill the audit log.
 */
import type { Database } from '../database';
import type { Row } from '../schema';

import { BaseRepo, runInTx, type Ctx } from './base';

export interface LanDeviceRow {
  id: string;
  name: string;
  platform: string;
  role: 'full' | 'counter' | 'view';
  tokenHash: string;
  tokenIssuedAt: number;
  prevTokenHash: string | null;
  prevValidUntil: number;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

const LAST_SEEN_EVERY_MS = 60_000;
const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => (v == null ? '' : String(v));

const toRow = (r: Row): LanDeviceRow => ({
  id: s(r['id']),
  name: s(r['name']),
  platform: s(r['platform']),
  role: (s(r['role']) || 'view') as LanDeviceRow['role'],
  tokenHash: s(r['token_hash']),
  tokenIssuedAt: n(r['token_issued_at']),
  prevTokenHash: r['prev_token_hash'] == null ? null : s(r['prev_token_hash']),
  prevValidUntil: n(r['prev_valid_until']),
  createdAt: n(r['created_at']),
  lastSeenAt: r['last_seen_at'] == null ? null : n(r['last_seen_at']),
  revokedAt: r['revoked_at'] == null ? null : n(r['revoked_at']),
});

export class LanDeviceRepo extends BaseRepo {
  constructor(d: Database) {
    super(d, 'devices');
  }

  private async rows(ctx: Ctx): Promise<Row[]> {
    return (await this.list(ctx)).filter((r) => r['kind'] === 'lan');
  }

  async devices(ctx: Ctx): Promise<LanDeviceRow[]> {
    return runInTx(this.d, ctx, async (tx) => (await this.rows({ ...ctx, tx })).map(toRow));
  }

  /** The device whose current token has this hash, or whose previous token has it and is still in its grace. */
  async findByHash(ctx: Ctx, hash: string, now: number): Promise<LanDeviceRow | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await this.rows({ ...ctx, tx });
      const hit = rows.find(
        (r) =>
          r['token_hash'] === hash ||
          (r['prev_token_hash'] === hash && n(r['prev_valid_until']) > now),
      );
      return hit ? toRow(hit) : null;
    });
  }

  /** Make or update a paired device. */
  async save(ctx: Ctx, d: LanDeviceRow): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const have = (await this.rows(c)).find((r) => r['id'] === d.id);
      const values = {
        name: d.name,
        platform: d.platform || null,
        role: d.role,
        token_hash: d.tokenHash,
        token_issued_at: d.tokenIssuedAt,
        prev_token_hash: d.prevTokenHash,
        prev_valid_until: d.prevValidUntil,
        last_seen_at: d.lastSeenAt,
        revoked_at: d.revokedAt,
      };
      if (!have) {
        await this.create(c, { id: d.id, kind: 'lan', ...values } as never);
        return;
      }
      const same = (Object.keys(values) as (keyof typeof values)[])
        .filter((k) => k !== 'last_seen_at')
        .every((k) => (have[k] ?? null) === (values[k] ?? null) || n(have[k]) === n(values[k]));
      const quiet =
        same &&
        have['last_seen_at'] != null &&
        n(values.last_seen_at) - n(have['last_seen_at']) < LAST_SEEN_EVERY_MS;
      if (quiet) return;
      await this.update(c, d.id, values as never, n(have['version']));
    });
  }
}

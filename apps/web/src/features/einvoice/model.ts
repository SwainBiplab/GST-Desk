/** What the e-invoice screens show, worked out from the rows (kept free of React so it can be tested). */
import type { Row } from '@gst/db';
import { ewbCancellable, ewbExtendable, explainGspError, irnCancellable } from '@gst/domain';

export type IrnState =
  | { kind: 'active'; einv: Row }
  | { kind: 'cancelled'; einv: Row }
  | { kind: 'queued' | 'running'; job: Row }
  | { kind: 'failed' | 'stopped'; job: Row; plain: string; next: string; retry: boolean }
  | { kind: 'none' };

/** The latest job of these kinds (jobs come newest first). */
export function latestJob(jobs: readonly Row[], kinds: readonly string[]): Row | null {
  return jobs.find((j) => kinds.includes(String(j['kind']))) ?? null;
}

const failure = (job: Row) => {
  const info = explainGspError(
    String(job['last_code'] ?? 'GD-UNKNOWN'),
    String(job['last_message'] ?? ''),
  );
  return { plain: info.plain, next: info.next, retry: info.retry };
};

/**
 * Where a document stands with its IRN. A recorded IRN wins; otherwise the latest request says it, so a
 * request that failed shows why and what to do (and a done one is waiting for its row to appear).
 */
export function irnState(einv: Row | null, jobs: readonly Row[]): IrnState {
  if (einv && einv['status'] === 'active') {
    // a cancellation on its way is shown as the IRN still being active, with that request beside it
    return { kind: 'active', einv };
  }
  if (einv && einv['status'] === 'cancelled') return { kind: 'cancelled', einv };
  const job = latestJob(jobs, ['irn']);
  if (!job) return { kind: 'none' };
  const st = String(job['status']);
  if (st === 'queued' || st === 'running') return { kind: st, job };
  if (st === 'failed' || st === 'stopped') return { kind: st, job, ...failure(job) };
  return { kind: 'none' };
}

/** A request about to be sent or failed, for the cancel and e-way bill actions. */
export function pendingOrFailed(
  jobs: readonly Row[],
  kinds: readonly string[],
): { pending: Row | null; failed: (Row & { plain: string; next: string }) | null } {
  const job = latestJob(jobs, kinds);
  if (!job) return { pending: null, failed: null };
  const st = String(job['status']);
  if (st === 'queued' || st === 'running') return { pending: job, failed: null };
  if (st === 'failed' || st === 'stopped') {
    const f = failure(job);
    return { pending: null, failed: { ...job, plain: f.plain, next: f.next } };
  }
  return { pending: null, failed: null };
}

export const canCancelIrn = (einv: Row, now: Date): boolean =>
  einv['status'] === 'active' && irnCancellable(String(einv['ack_date'] ?? ''), now);

export type EwbView = 'active' | 'expired' | 'cancelled';

export function ewbView(w: Row, now: Date): EwbView {
  if (w['status'] === 'cancelled') return 'cancelled';
  const until = Date.parse(String(w['valid_until'] ?? ''));
  return Number.isFinite(until) && until < now.getTime() ? 'expired' : 'active';
}

/** Whole hours left before an e-way bill expires (0 in its last hour), or null once it has. */
export function hoursLeft(validUntil: string, now: Date): number | null {
  const until = Date.parse(validUntil);
  if (!Number.isFinite(until)) return null;
  const ms = until - now.getTime();
  return ms < 0 ? null : Math.floor(ms / 3_600_000);
}

export const canCancelEwb = (w: Row, now: Date): boolean =>
  w['status'] !== 'cancelled' && ewbCancellable(String(w['generated_at'] ?? ''), now);

export const canExtendEwb = (w: Row, now: Date): boolean =>
  w['status'] !== 'cancelled' && ewbExtendable(String(w['valid_until'] ?? ''), now);

/** `2026-04-04T23:59:59+05:30` as the person reads it: 04/04/2026 23:59 (Indian time). */
export function istText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : iso;
}

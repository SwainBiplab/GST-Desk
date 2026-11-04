/**
 * Period lock (FR-043): documents dated on or before the lock date cannot be issued, revised or
 * cancelled without an owner's override and a reason. Everything here is audited.
 */
import { isLockedDate } from '@gst/domain';

import type { Database } from '../database';

import { SettingsRepo } from './aggregates';
import { RuleError, runInTx, writeAudit, type Ctx } from './base';

const KEY = 'period_lock';

export interface LockInfo {
  /** Documents dated on or before this day are locked (ISO). */
  until: string;
  reason: string | null;
  setBy: string;
  at: number;
}

export interface LockOverride {
  reason: string;
}

export class PeriodLockedError extends RuleError {
  override name = 'PeriodLockedError';
  constructor(
    readonly until: string,
    readonly date: string,
  ) {
    super(
      `The books are locked up to ${until}, and this document is dated ${date}. An owner can unlock with a reason.`,
    );
  }
}

const isOwner = (ctx: Ctx) => (ctx.role ?? 'owner') === 'owner';

export class PeriodLockRepo {
  private readonly settings: SettingsRepo;

  constructor(private readonly d: Database) {
    this.settings = new SettingsRepo(d);
  }

  async get(ctx: Ctx): Promise<LockInfo | null> {
    const v = await this.settings.getValue<LockInfo | null>(ctx, KEY);
    return v && typeof v === 'object' && 'until' in v ? v : null;
  }

  /**
   * Lock up to `until`. Moving the lock later is free; moving it earlier or removing it is an unlock,
   * which only an owner can do and which needs a reason.
   */
  async set(ctx: Ctx, until: string | null, reason?: string): Promise<LockInfo | null> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const current = await this.get(c);
      const unlocking = !!current && (until === null || until < current.until);
      if (unlocking) {
        if (!isOwner(c)) throw new RuleError('Only an owner can unlock a closed period.');
        if (!reason?.trim()) throw new RuleError('Say why the period is being unlocked.');
      }
      if (until === null && !current) return null;
      if (until !== null && !/^\d{4}-\d{2}-\d{2}$/.test(until))
        throw new RuleError('The lock date must be a valid date.');
      const next: LockInfo | null =
        until === null
          ? null
          : { until, reason: reason?.trim() || null, setBy: c.actor, at: Date.now() };
      // the settings row is audited by the repository; this entry carries the reason in plain view
      await writeAudit(
        this.d,
        tx,
        c,
        'period_lock',
        c.businessId,
        'update',
        current ? { ...current } : null,
        next ? { ...next } : { until: null, reason: reason?.trim() ?? null },
      );
      await this.settings.set(c, KEY, next);
      return next;
    });
  }

  /**
   * Throws unless `date` is open, or the caller is an owner who gave a reason. A used override is
   * written to the audit trail with what it allowed.
   */
  async assertOpen(
    ctx: Ctx,
    date: string,
    what: { action: string; documentId: string },
    override?: LockOverride,
  ): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const lock = await this.get(c);
      if (!isLockedDate(lock, date)) return;
      if (!override) throw new PeriodLockedError(lock!.until, date);
      if (!isOwner(c)) throw new RuleError('Only an owner can work inside a locked period.');
      if (!override.reason.trim())
        throw new RuleError('Say why the locked period is being changed.');
      await writeAudit(
        this.d,
        tx,
        c,
        'period_lock',
        what.documentId,
        'update',
        { until: lock!.until },
        { override: override.reason.trim(), action: what.action, documentDate: date },
      );
    });
  }
}

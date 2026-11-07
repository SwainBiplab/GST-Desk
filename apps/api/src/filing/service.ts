/**
 * GST filing through the GSP (prompt 46). The taxpayer logs in to the return portal with an OTP they type; the
 * session token (never a password) is kept sealed for the six hours it lives. Jobs then save a return on the portal,
 * pull GSTR-2B and 2A, and ask whether a return was filed, each metered, audited through the repositories, and each
 * leaving the local books unchanged when it fails. Nothing here files a return: the taxpayer does that on the portal,
 * and the ARN is picked up afterwards. Logs carry ids, periods and codes, never a token, OTP or invoice number.
 */
import { Gstr2bRepo, GstrRepo, ReviewRepo, SettingsRepo, newId, type Ctx, type Row } from '@gst/db';
import {
  checkGstr1Json,
  dueDate,
  gstr1Json,
  iffJson,
  isNilPeriod,
  lateFee,
  monthPeriod,
  nilGstr1Json,
  parse2bJson,
  quarterPeriod,
  type GstrPeriod,
  type LateFee,
  type Return,
} from '@gst/domain';
import {
  GspError,
  type GspAdapter,
  type GspSession,
  type PushTableResult,
  type ReturnForm,
} from '@gst/gsp';
import { istDate } from '@gst/messaging';
import { openSecret, sealSecret } from '@gst/payments';
import type { Logger } from 'pino';

import type { PgDatabase } from '../db/pool';

export type JobKind = 'push' | 'pull_2b' | 'pull_2a' | 'poll_filing';
export type JobStatus =
  'queued' | 'running' | 'waiting_otp' | 'processing' | 'done' | 'partial' | 'failed';

export interface FilingJob {
  org_id: string;
  id: string;
  business_id: string;
  kind: JobKind;
  form: string | null;
  period_fp: string;
  status: JobStatus;
}

export interface ServiceOptions {
  db: PgDatabase;
  secretsKey: string | null;
  log: Logger;
  now?: () => number;
  /** The GSP. Null when the server has none: every call then says so. */
  adapter: GspAdapter | null;
  /** Put a job on the queue (optionally later). Without one, jobs wait for `run` to be called. */
  enqueue?: (job: { orgId: string; jobId: string }, delayMs?: number) => Promise<void>;
}

export class FilingError extends Error {
  override name = 'FilingError';
  constructor(
    message: string,
    readonly code:
      'no_gsp' | 'no_key' | 'plan' | 'limit' | 'no_session' | 'not_found' | 'rule' | 'portal',
  ) {
    super(message);
  }
}

const POLLS_INLINE = 3;
const monthStart = (ms: number): number => {
  const d = istDate(ms);
  return Date.parse(`${d.slice(0, 7)}-01T00:00:00+05:30`);
};

/** A period from its MMYYYY key, as the business files it (monthly or QRMP quarterly). IFF is always a month. */
export function periodFromFp(gstin: string, fp: string, kind: 'month' | 'quarter'): GstrPeriod {
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(fp))
    throw new FilingError('That is not a return period (MMYYYY).', 'rule');
  const month = Number(fp.slice(0, 2));
  const year = Number(fp.slice(2));
  if (kind === 'quarter') {
    if (month % 3 !== 0)
      throw new FilingError(
        'A quarterly return ends in March, June, September or December.',
        'rule',
      );
    return quarterPeriod(gstin, year, month);
  }
  return monthPeriod(gstin, year, month);
}

export class FilingService {
  private readonly now: () => number;

  constructor(private readonly o: ServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  /* --------------------------------------------------------------------------------- plumbing */

  private org(orgId: string, fn: (tx: any) => Promise<any>): Promise<any> {
    return this.o.db.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
      return fn(tx);
    });
  }

  private ctx(orgId: string, businessId: string, actor = 'system:filing'): Ctx {
    return { orgId, businessId, actor, deviceId: 'api' };
  }

  private gsp(): GspAdapter {
    if (!this.o.adapter) throw new FilingError('No GSP is set up on this server.', 'no_gsp');
    return this.o.adapter;
  }

  private key(): string {
    if (!this.o.secretsKey)
      throw new FilingError('This server cannot seal portal sessions yet.', 'no_key');
    return this.o.secretsKey;
  }

  private async kindOf(ctx: Ctx): Promise<'month' | 'quarter'> {
    const v = await new SettingsRepo(this.o.db).getValue<string>(ctx, 'gst.filing.kind');
    return v === 'quarter' ? 'quarter' : 'month';
  }

  /* --------------------------------------------------------------------------------- plan and metering */

  async entitlement(orgId: string) {
    return this.org(orgId, async (tx) => {
      const [p] =
        await tx`SELECT s.status, pl.limits_json FROM subscriptions s JOIN plans pl ON pl.id = s.plan_id WHERE s.org_id = ${orgId}`;
      const limit = Number(
        (p?.['limits_json'] as { gspCalls?: number } | undefined)?.gspCalls ?? 0,
      );
      const active = p && ['active', 'trial'].includes(String(p['status']));
      const [u] =
        await tx`SELECT coalesce(sum(quantity), 0)::bigint AS n FROM usage_events WHERE org_id = ${orgId} AND kind = 'gsp_call' AND at >= ${monthStart(this.now())}`;
      return { enabled: !!active && limit > 0, used: Number(u?.['n'] ?? 0), limit };
    }) as Promise<{ enabled: boolean; used: number; limit: number }>;
  }

  /** Every call to the portal counts against the plan; one past the limit is refused before it is made. */
  private async meter(orgId: string, businessId: string, ref: string): Promise<void> {
    const e = await this.entitlement(orgId);
    if (!e.enabled)
      throw new FilingError('Filing through the GSP is part of the cloud plan.', 'plan');
    if (e.used >= e.limit)
      throw new FilingError(`This month's ${e.limit} GSP calls are used up.`, 'limit');
    const now = this.now();
    await this.org(
      orgId,
      (tx) =>
        tx`INSERT INTO usage_events (id, org_id, business_id, kind, quantity, ref, at, created_at) VALUES (${newId()}, ${orgId}, ${businessId}, 'gsp_call', 1, ${ref}, ${now}, ${now})`,
    );
  }

  /* --------------------------------------------------------------------------------- the portal login */

  async sessionState(orgId: string, businessId: string) {
    const [s] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM gstn_sessions WHERE org_id = ${orgId} AND business_id = ${businessId}`,
    );
    const now = this.now();
    return {
      configured: !!this.o.adapter,
      practice: !!this.o.adapter?.sandbox,
      vendor: this.o.adapter?.name ?? null,
      connected: !!s?.['token_enc'] && Number(s['expires_at'] ?? 0) > now,
      expiresAt: s?.['expires_at'] == null ? null : Number(s['expires_at']),
      username: (s?.['username'] as string | undefined) ?? null,
      gstin: (s?.['gstin'] as string | undefined) ?? null,
      otpPending: !!s?.['otp_txn_id'] && Number(s['otp_expires_at'] ?? 0) > now,
    };
  }

  /** Ask the portal to send the OTP to the taxpayer's registered number. */
  async requestOtp(orgId: string, businessId: string, username: string, by: string) {
    const gsp = this.gsp();
    this.key();
    const { gstin } = await new GstrRepo(this.o.db).businessInfo(this.ctx(orgId, businessId));
    if (!gstin) throw new FilingError('This business has no GSTIN yet.', 'rule');
    await this.meter(orgId, businessId, 'otp');
    let ch;
    try {
      ch = await gsp.requestGstnOtp({ gstin, username: username.trim() });
    } catch (e) {
      throw this.portal(e);
    }
    await this.org(
      orgId,
      (
        tx,
      ) => tx`INSERT INTO gstn_sessions (org_id, business_id, gstin, username, otp_txn_id, otp_expires_at, updated_by, updated_at)
        VALUES (${orgId}, ${businessId}, ${gstin}, ${username.trim()}, ${ch.txnId}, ${ch.expiresAt}, ${by}, ${this.now()})
        ON CONFLICT (org_id, business_id) DO UPDATE SET gstin = EXCLUDED.gstin, username = EXCLUDED.username, otp_txn_id = EXCLUDED.otp_txn_id,
          otp_expires_at = EXCLUDED.otp_expires_at, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    );
    return this.sessionState(orgId, businessId);
  }

  /** The OTP the taxpayer typed in. It is sent to the portal and not kept. */
  async verifyOtp(orgId: string, businessId: string, otp: string, by: string) {
    const gsp = this.gsp();
    const k = this.key();
    const [s] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM gstn_sessions WHERE org_id = ${orgId} AND business_id = ${businessId}`,
    );
    if (!s?.['otp_txn_id']) throw new FilingError('Ask for an OTP first.', 'rule');
    await this.meter(orgId, businessId, 'verify');
    let session: GspSession;
    try {
      session = await gsp.verifyGstnOtp(
        { gstin: String(s['gstin']), username: String(s['username']) },
        String(s['otp_txn_id']),
        otp.trim(),
      );
    } catch (e) {
      throw this.portal(e);
    }
    await this.org(
      orgId,
      (
        tx,
      ) => tx`UPDATE gstn_sessions SET token_enc = ${sealSecret(session.token, k, orgId)}, expires_at = ${session.expiresAt}, otp_txn_id = NULL, otp_expires_at = NULL,
        updated_by = ${by}, updated_at = ${this.now()} WHERE org_id = ${orgId} AND business_id = ${businessId}`,
    );
    return this.sessionState(orgId, businessId);
  }

  async signOut(orgId: string, businessId: string): Promise<void> {
    await this.org(
      orgId,
      (tx) =>
        tx`UPDATE gstn_sessions SET token_enc = NULL, expires_at = NULL, otp_txn_id = NULL, updated_at = ${this.now()} WHERE org_id = ${orgId} AND business_id = ${businessId}`,
    );
  }

  private async live(orgId: string, businessId: string): Promise<GspSession | null> {
    const [s] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM gstn_sessions WHERE org_id = ${orgId} AND business_id = ${businessId}`,
    );
    if (!s?.['token_enc'] || Number(s['expires_at'] ?? 0) <= this.now()) return null;
    return {
      portal: 'gstn',
      gstin: String(s['gstin']),
      token: openSecret(String(s['token_enc']), this.key(), orgId),
      expiresAt: Number(s['expires_at']),
    };
  }

  private portal(e: unknown): FilingError {
    if (e instanceof FilingError) return e;
    if (e instanceof GspError) return new FilingError(`${e.message} (${e.code})`, 'portal');
    return new FilingError(e instanceof Error ? e.message : String(e), 'portal');
  }

  /* --------------------------------------------------------------------------------- jobs */

  /** Ask for a job; the same ask while one is live returns that one. */
  async start(a: {
    orgId: string;
    businessId: string;
    kind: JobKind;
    form?: string | null;
    fp: string;
    by: string;
  }): Promise<{ id: string; existing: boolean }> {
    this.gsp();
    this.key();
    const e = await this.entitlement(a.orgId);
    if (!e.enabled)
      throw new FilingError('Filing through the GSP is part of the cloud plan.', 'plan');
    const form = a.form ?? (a.kind === 'push' || a.kind === 'poll_filing' ? 'gstr1' : null);
    const id = newId();
    const now = this.now();
    const made = await this.org(
      a.orgId,
      (
        tx,
      ) => tx`INSERT INTO filing_jobs (id, org_id, business_id, kind, form, period_fp, created_by, created_at, updated_at)
        VALUES (${id}, ${a.orgId}, ${a.businessId}, ${a.kind}, ${form}, ${a.fp}, ${a.by}, ${now}, ${now})
        ON CONFLICT DO NOTHING RETURNING id`,
    );
    if (!made.length) {
      const [live] = await this.org(
        a.orgId,
        (
          tx,
        ) => tx`SELECT id FROM filing_jobs WHERE org_id = ${a.orgId} AND business_id = ${a.businessId} AND kind = ${a.kind}
          AND coalesce(form, '') = ${form ?? ''} AND period_fp = ${a.fp} AND status IN ('queued', 'running', 'processing', 'waiting_otp')`,
      );
      return { id: String(live!['id']), existing: true };
    }
    await this.o.enqueue?.({ orgId: a.orgId, jobId: id });
    return { id, existing: false };
  }

  async jobs(orgId: string, businessId: string, limit = 30) {
    const rows: Row[] = await this.org(
      orgId,
      (tx) =>
        tx`SELECT * FROM filing_jobs WHERE org_id = ${orgId} AND business_id = ${businessId} ORDER BY created_at DESC LIMIT ${limit}`,
    );
    return rows.map((r) => this.jobView(r));
  }

  async job(orgId: string, id: string) {
    const [r] = await this.org(
      orgId,
      (tx) => tx`SELECT * FROM filing_jobs WHERE org_id = ${orgId} AND id = ${id}`,
    );
    if (!r) throw new FilingError('No such job.', 'not_found');
    return this.jobView(r);
  }

  private jobView(r: Row) {
    return {
      id: String(r['id']),
      businessId: String(r['business_id']),
      kind: String(r['kind']) as JobKind,
      form: (r['form'] as string | null) ?? null,
      period: String(r['period_fp']),
      status: String(r['status']) as JobStatus,
      reference: (r['reference'] as string | null) ?? null,
      result: (r['result_json'] as Record<string, unknown> | null) ?? null,
      error: (r['error'] as string | null) ?? null,
      createdAt: Number(r['created_at']),
      updatedAt: Number(r['updated_at']),
    };
  }

  private async finish(
    orgId: string,
    id: string,
    status: JobStatus,
    patch: {
      result?: unknown;
      error?: string | null;
      reference?: string | null;
      hash?: string | null;
    } = {},
  ) {
    await this.org(
      orgId,
      (
        tx,
      ) => tx`UPDATE filing_jobs SET status = ${status}, result_json = coalesce(${patch.result === undefined ? null : JSON.stringify(patch.result)}::jsonb, result_json),
        error = ${patch.error ?? null}, reference = coalesce(${patch.reference ?? null}, reference), payload_hash = coalesce(${patch.hash ?? null}, payload_hash),
        updated_at = ${this.now()} WHERE id = ${id}`,
    );
  }

  /** Run a job. Returns its final status; a job that waits for a person is not an error to retry. */
  async run(orgId: string, jobId: string): Promise<JobStatus> {
    const [r] = await this.org(
      orgId,
      (tx) => tx`SELECT * FROM filing_jobs WHERE org_id = ${orgId} AND id = ${jobId}`,
    );
    if (!r) return 'failed';
    const job = this.jobView(r);
    if (['done', 'partial', 'failed'].includes(job.status)) return job.status;
    await this.org(
      orgId,
      (tx) =>
        tx`UPDATE filing_jobs SET status = 'running', attempts = attempts + 1, updated_at = ${this.now()} WHERE id = ${jobId}`,
    );
    const businessId = job.businessId;
    try {
      const session = await this.live(orgId, businessId);
      if (!session) {
        await this.finish(orgId, jobId, 'waiting_otp', {
          error: 'Sign in to the GST portal with an OTP first.',
        });
        await this.attention(
          orgId,
          businessId,
          job.period,
          job.form ?? job.kind,
          'otp',
          'Sign in to the GST portal with an OTP to continue.',
        );
        return 'waiting_otp';
      }
      switch (job.kind) {
        case 'push':
          return await this.runPush(
            orgId,
            businessId,
            jobId,
            job.period,
            (job.form as ReturnForm) ?? 'gstr1',
            session,
            r['reference'] as string | null,
          );
        case 'pull_2b':
          return await this.runPull(orgId, businessId, jobId, job.period, '2b', session);
        case 'pull_2a':
          return await this.runPull(orgId, businessId, jobId, job.period, '2a', session);
        case 'poll_filing':
          return await this.runPoll(
            orgId,
            businessId,
            jobId,
            job.period,
            (job.form as 'gstr1' | 'gstr3b') ?? 'gstr1',
            session,
          );
      }
    } catch (e) {
      const err = this.portal(e);
      const expired =
        err.message.includes('GD-AUTH') || err.message.toLowerCase().includes('expired');
      this.o.log.warn(
        { org: orgId, job: jobId, kind: job.kind, period: job.period, code: err.code },
        'filing job failed',
      );
      if (expired) {
        await this.org(
          orgId,
          (tx) =>
            tx`UPDATE gstn_sessions SET token_enc = NULL, expires_at = NULL WHERE org_id = ${orgId} AND business_id = ${businessId}`,
        );
        await this.finish(orgId, jobId, 'waiting_otp', {
          error: 'The portal login ran out. Sign in again with an OTP.',
        });
        await this.attention(
          orgId,
          businessId,
          job.period,
          job.form ?? job.kind,
          'otp',
          'The portal login ran out; sign in again with an OTP to continue.',
        );
        return 'waiting_otp';
      }
      await this.finish(orgId, jobId, 'failed', { error: err.message.slice(0, 300) });
      if (job.kind !== 'poll_filing')
        await this.attention(
          orgId,
          businessId,
          job.period,
          job.form ?? job.kind,
          job.kind === 'push' ? 'push_failed' : 'pull_failed',
          err.message.slice(0, 200),
        );
      return 'failed';
    }
  }

  /* --------------------------------------------------------------------------------- push */

  private async runPush(
    orgId: string,
    businessId: string,
    jobId: string,
    fp: string,
    form: ReturnForm,
    session: GspSession,
    reference: string | null,
  ): Promise<JobStatus> {
    const gsp = this.gsp();
    const ctx = this.ctx(orgId, businessId);
    const kind = form === 'iff' ? 'month' : await this.kindOf(ctx);
    const period = periodFromFp(session.gstin, fp, kind);

    // already saved, and only waiting for the portal to finish: ask, do not save again
    if (!reference) {
      const review = await new GstrRepo(this.o.db).review(ctx, period);
      if (review.blockers > 0) {
        const message = `${review.blockers} problem${review.blockers === 1 ? '' : 's'} in ${fp} must be fixed or acknowledged first.`;
        await this.finish(orgId, jobId, 'failed', {
          error: message,
          result: { blockers: review.blockers },
        });
        await this.attention(orgId, businessId, fp, form, 'blocked', message);
        return 'failed';
      }
      const nil = form === 'gstr1' && !review.hasDocuments;
      const file = nil
        ? nilGstr1Json(period)
        : form === 'iff'
          ? iffJson(gstr1Json(review.gstr1))
          : gstr1Json(review.gstr1);
      if (!nil) {
        const bad = checkGstr1Json(file);
        if (bad.length) {
          await this.finish(orgId, jobId, 'failed', {
            error: `The file failed its own check: ${bad[0]}`,
          });
          await this.attention(
            orgId,
            businessId,
            fp,
            form,
            'blocked',
            `The file failed its own check: ${bad[0]}`,
          );
          return 'failed';
        }
      }
      const hash = await sha256(JSON.stringify(file));
      // the same file as the last successful push is not sent again
      const [same] = await this.org(
        orgId,
        (
          tx,
        ) => tx`SELECT id, reference, result_json FROM filing_jobs WHERE org_id = ${orgId} AND business_id = ${businessId} AND kind = 'push' AND form = ${form}
          AND period_fp = ${fp} AND status = 'done' AND payload_hash = ${hash} AND id <> ${jobId} ORDER BY created_at DESC LIMIT 1`,
      );
      if (same) {
        await this.finish(orgId, jobId, 'done', {
          reference: same['reference'] as string,
          hash,
          result: { ...(same['result_json'] as object), unchanged: true },
        });
        return 'done';
      }
      await this.meter(orgId, businessId, `push:${fp}`);
      const res = await gsp.pushGstr1(session, fp, file, { form, nil });
      reference = res.reference;
      await this.finish(orgId, jobId, 'processing', {
        reference,
        hash,
        result: { tables: res.tables, nil },
      });
    }

    // the portal processes an upload after taking it: ask a few times now, then later
    for (let i = 0; i < POLLS_INLINE; i++) {
      await this.meter(orgId, businessId, `status:${fp}`);
      const st = await gsp.getPushStatus(session, fp, reference);
      if (st.state === 'processing') continue;
      return this.pushResult(orgId, businessId, jobId, fp, form, period, reference, st.tables);
    }
    await this.o.enqueue?.({ orgId, jobId }, 30_000);
    return 'processing';
  }

  private async pushResult(
    orgId: string,
    businessId: string,
    jobId: string,
    fp: string,
    form: ReturnForm,
    period: GstrPeriod,
    reference: string,
    tables: PushTableResult[],
  ): Promise<JobStatus> {
    const failed = tables.filter((t) => t.status === 'error');
    if (!failed.length) {
      await this.finish(orgId, jobId, 'done', { result: { tables }, reference });
      // the local state moves only now, when the portal has it all
      if (form === 'gstr1')
        await new GstrRepo(this.o.db).markPushed(
          this.ctx(orgId, businessId),
          'gstr1',
          period,
          reference,
        );
      return 'done';
    }
    const n = failed.reduce((c, t) => c + t.errors.length, 0);
    await this.finish(orgId, jobId, 'partial', {
      result: { tables },
      reference,
      error: `The portal refused ${n} item${n === 1 ? '' : 's'}.`,
    });
    await this.attention(
      orgId,
      businessId,
      fp,
      form,
      'push_partial',
      `The portal refused ${n} item${n === 1 ? '' : 's'} in ${failed.map((t) => t.table).join(', ')}. Fix them and push again.`,
    );
    return 'partial';
  }

  /* --------------------------------------------------------------------------------- pull */

  private async runPull(
    orgId: string,
    businessId: string,
    jobId: string,
    fp: string,
    which: '2a' | '2b',
    session: GspSession,
  ): Promise<JobStatus> {
    const gsp = this.gsp();
    const ctx = this.ctx(orgId, businessId);
    await this.meter(orgId, businessId, `${which}:${fp}`);
    let json: Record<string, unknown>;
    try {
      json = which === '2b' ? await gsp.pullGstr2b(session, fp) : await gsp.pullGstr2a(session, fp);
    } catch (e) {
      // the portal has not made it yet: a plain answer, not a failure to retry blindly
      if (e instanceof GspError && e.code === 'RTN00024') {
        await this.finish(orgId, jobId, 'failed', { error: `${e.message}` });
        return 'failed';
      }
      throw e;
    }
    const parsed = parse2bJson(JSON.stringify(json));
    if (which === '2a') {
      // 2A is a running statement, not the authority for credit: summarised for the CA, not matched
      await this.finish(orgId, jobId, 'done', {
        result: {
          entries: parsed.entries.length,
          problems: parsed.problems.length,
          note: '2A is shown for reference; credit is decided on 2B',
        },
      });
      return 'done';
    }
    // GSTR-2B is monthly for everyone, QRMP included
    const period = periodFromFp(session.gstin, fp, 'month');
    const imp = await new Gstr2bRepo(this.o.db).importReturn(ctx, parsed, {
      source: 'json',
      period: fp,
    });
    // matching runs on the import: say what it found, so the CA sees the result without opening the tab
    const ws = await new Gstr2bRepo(this.o.db).workspace(ctx, period);
    const heads = (h: { igst: number; cgst: number; sgst: number; cess: number }) =>
      h.igst + h.cgst + h.sgst + h.cess;
    await this.finish(orgId, jobId, 'done', {
      result: {
        imported: imp.count,
        problems: imp.problems.length,
        matched: ws.summary.counts.matched,
        withDifferences: ws.summary.counts.matched_with_differences,
        onlyIn2b: ws.summary.counts.in_2b_not_in_books,
        onlyInBooks: ws.summary.counts.in_books_not_in_2b,
        itcToDeferPaise: heads(ws.summary.toDefer),
        itcOnlyIn2bPaise: heads(ws.summary.only2b),
        itcToReversePaise: heads(ws.summary.toReverse),
      },
    });
    return 'done';
  }

  /* --------------------------------------------------------------------------------- filing confirmation */

  private async runPoll(
    orgId: string,
    businessId: string,
    jobId: string,
    fp: string,
    form: 'gstr1' | 'gstr3b',
    session: GspSession,
  ): Promise<JobStatus> {
    const gsp = this.gsp();
    const ctx = this.ctx(orgId, businessId);
    await this.meter(orgId, businessId, `filing:${form}:${fp}`);
    const st = await gsp.getFilingState(session, fp, form);
    if (!st.filed || !st.arn || !st.filedOn) {
      await this.finish(orgId, jobId, 'done', { result: { filed: false } });
      return 'done';
    }
    const kind = await this.kindOf(ctx);
    const period = periodFromFp(session.gstin, fp, form === 'gstr1' ? kind : 'month');
    await new GstrRepo(this.o.db).markFiled(ctx, form as Return, period, {
      arn: st.arn,
      filedOn: st.filedOn,
    });
    await this.finish(orgId, jobId, 'done', {
      result: { filed: true, arn: st.arn, filedOn: st.filedOn },
    });
    await this.attention(
      orgId,
      businessId,
      fp,
      form,
      'filed',
      `${form.toUpperCase()} for ${fp} is filed on the portal (ARN ${st.arn}).`,
    );
    return 'done';
  }

  /** Ask the portal about every return that is saved or exported but not filed, for each business that is signed in. */
  async scan(): Promise<{ asked: number }> {
    if (!this.o.adapter || !this.o.secretsKey) return { asked: 0 };
    const targets = await this.o.db.sql`SELECT org_id, business_id FROM gstn_session_orgs`;
    let asked = 0;
    for (const t of targets) {
      const orgId = String(t['org_id']);
      const businessId = String(t['business_id']);
      if (!(await this.live(orgId, businessId))) continue;
      const filings = await new GstrRepo(this.o.db).listFilings(this.ctx(orgId, businessId));
      for (const f of filings.filter((x) => x.status === 'pushed' || x.status === 'exported')) {
        try {
          await this.start({
            orgId,
            businessId,
            kind: 'poll_filing',
            form: f.returnType,
            fp: f.fp,
            by: 'system:scan',
          });
          asked++;
        } catch {
          /* plan or limit: nothing to ask */
        }
      }
    }
    return { asked };
  }

  /* --------------------------------------------------------------------------------- the Filing Desk's extras */

  /** The period a business files for `fp`: a month, or a quarter when it is on QRMP. */
  async periodFor(orgId: string, businessId: string, fp: string): Promise<GstrPeriod> {
    const ctx = this.ctx(orgId, businessId);
    const info = await new GstrRepo(this.o.db).businessInfo(ctx);
    return periodFromFp(info.gstin, fp, await this.kindOf(ctx));
  }

  /** Late fee and nil flag for one return, as the desk shows them. */
  async deskInfo(
    orgId: string,
    businessId: string,
    ret: Return,
    fp: string,
  ): Promise<{ due: string; lateFee: LateFee; nil: boolean; filed: boolean }> {
    const ctx = this.ctx(orgId, businessId);
    const gr = new GstrRepo(this.o.db);
    const info = await gr.businessInfo(ctx);
    const kind = await this.kindOf(ctx);
    const period = periodFromFp(info.gstin, fp, kind);
    const filings = await gr.listFilings(ctx);
    const rec = filings.find((f) => f.returnType === ret && f.fp === fp);
    const due = dueDate(
      ret,
      period,
      info.stateCode,
      rec?.dueOverride ? { [`${ret}:${fp}`]: rec.dueOverride } : {},
    ).date;
    const review = await gr.review(ctx, period);
    const nil = isNilPeriod(review.hasDocuments ? 1 : 0);
    const turnover = await gr.priorYearTurnover(ctx, period);
    const on = rec?.status === 'filed' && rec.filedOn ? rec.filedOn : istDate(this.now());
    return {
      due,
      lateFee: lateFee({ due, on, nil, turnoverPaise: BigInt(turnover) }),
      nil,
      filed: rec?.status === 'filed',
    };
  }

  private async attention(
    orgId: string,
    businessId: string,
    period: string,
    form: string,
    reason: 'otp' | 'blocked' | 'push_partial' | 'push_failed' | 'pull_failed' | 'filed',
    message: string,
  ): Promise<void> {
    try {
      await new ReviewRepo(this.o.db).create(this.ctx(orgId, businessId), {
        kind: 'filing_attention',
        status: 'pending',
        payload_json: { period, form, reason },
        suggestion_json: { period, form, reason, message },
        diff_json: null,
        source: 'gsp',
        confidence: null,
        // one card per reason and period until it is dealt with
        dedupe_key: `filing_attention:${businessId}:${period}:${form}:${reason}`,
      });
    } catch {
      /* the same card is already there */
    }
  }
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The GST portal through the GSP (prompt 46), on the Filing Desk: sign in with the OTP the portal sends, save a
 * return on the portal, pull 2B and 2A, and ask whether a return has been filed. Saving is not filing: the taxpayer
 * files on the portal, and this screen says so, with the steps and the figures to check. Late fees are estimates.
 */
import { iffMonths, type GstrPeriod } from '@gst/domain';
import { Badge, Button, Card, Input, formatPaise, toast } from '@gst/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CloudError,
  type FilingDesk,
  type FilingJob,
  type FilingStatusView,
} from '@/features/cloud/client';
import { useMessaging, type Messaging } from '@/features/dispatch/use-messaging';
import { dyn } from '@/lib/dyn-key';

export const JOB_POLL_MS = 2000;
const LIVE = new Set(['queued', 'running', 'processing']);
const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);
const TONE: Record<string, 'success' | 'danger' | 'warning' | 'info'> = {
  done: 'success',
  failed: 'danger',
  partial: 'warning',
  waiting_otp: 'warning',
  queued: 'info',
  running: 'info',
  processing: 'info',
};

/** Above the periods: is the business signed in to the portal, and the OTP steps to sign in. */
export function PortalLogin() {
  const { t } = useTranslation();
  const state = useMessaging();
  const [st, setSt] = useState<FilingStatusView | null>(null);
  const [user, setUser] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const m = state.kind === 'ready' ? state.m : null;

  useEffect(() => {
    if (!m) return;
    void m.client.filingStatus(m.orgId, m.businessId).then(
      (s) => {
        // an answer without a session (an older server, a stub) is treated as "not set up"
        if (!s?.session || !s.entitlement) return;
        setSt(s);
        setUser((u) => u || s.session.username || '');
      },
      () => undefined,
    );
  }, [m]);
  if (!m || !st) return null;
  const s = st.session;
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(t(dyn(ok)));
      setSt(await m.client.filingStatus(m.orgId, m.businessId));
      setOtp('');
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="portal-login">
      <h2 className="font-medium">{t('filing.login.title')}</h2>
      {!st.entitlement.enabled ? (
        <p className="text-sm text-fg-muted" data-testid="portal-plan">
          {t('filing.login.plan')}
        </p>
      ) : !s.configured ? (
        <p className="text-sm text-fg-muted">{t('filing.login.noGsp')}</p>
      ) : s.connected ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="portal-connected">
          <Badge tone="success">{t('filing.login.connected')}</Badge>
          <span>
            {t('filing.login.until', { at: new Date(s.expiresAt ?? 0).toLocaleTimeString() })}
          </span>
          <Button
            variant="ghost"
            data-testid="portal-signout"
            disabled={busy}
            onClick={() => void run(() => m.client.signOutPortal(m.orgId, m.businessId))}
          >
            {t('filing.login.signOut')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-fg-muted">{t('filing.login.help')}</p>
          {s.practice && (
            <p className="text-xs text-warning" data-testid="portal-practice">
              {t('filing.login.practice')}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              {t('filing.login.user')}
              <Input
                className="w-56"
                value={user}
                data-testid="portal-user"
                onChange={(e) => setUser(e.target.value)}
              />
            </label>
            <Button
              variant="secondary"
              data-testid="portal-send-otp"
              disabled={busy || user.trim().length < 2}
              onClick={() =>
                void run(
                  () =>
                    m.client.requestPortalOtp(m.orgId, {
                      businessId: m.businessId,
                      username: user.trim(),
                    }),
                  'filing.login.sent',
                )
              }
            >
              {t('filing.login.sendOtp')}
            </Button>
          </div>
          {s.otpPending && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                {t('filing.login.otp')}
                <Input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="w-32"
                  value={otp}
                  data-testid="portal-otp"
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                />
              </label>
              <Button
                data-testid="portal-verify"
                disabled={busy || otp.length < 4}
                onClick={() =>
                  void run(
                    () => m.client.verifyPortalOtp(m.orgId, { businessId: m.businessId, otp }),
                    'filing.login.signedIn',
                  )
                }
              >
                {t('filing.login.verify')}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** In a period's detail: late fee and nil flag, the actions, what each job did, and the steps to file. */
export function PortalTab({ period, kind }: { period: GstrPeriod; kind: 'month' | 'quarter' }) {
  const { t } = useTranslation();
  const state = useMessaging();
  if (state.kind !== 'ready')
    return (
      <p className="text-sm text-fg-muted" data-testid="portal-unavailable">
        {t(dyn(`dispatch.unavailable.${state.kind}`))}
      </p>
    );
  return <Portal m={state.m} period={period} kind={kind} />;
}

function Portal({
  m,
  period,
  kind,
}: {
  m: Messaging;
  period: GstrPeriod;
  kind: 'month' | 'quarter';
}) {
  const { t } = useTranslation();
  const fp = period.fp;
  const [jobs, setJobs] = useState<FilingJob[]>([]);
  const [desk, setDesk] = useState<Record<string, FilingDesk>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () => m.client.filingJobs(m.orgId, m.businessId).then(setJobs, () => undefined),
    [m],
  );
  useEffect(() => {
    void m.client.filingJobs(m.orgId, m.businessId).then(setJobs, () => undefined);
    for (const ret of ['gstr1', 'gstr3b'] as const)
      void m.client.filingDesk(m.orgId, m.businessId, ret, fp).then(
        (d) => setDesk((x) => ({ ...x, [ret]: d })),
        () => undefined,
      );
  }, [m, fp]);
  const hasLive = jobs.some((j) => LIVE.has(j.status));
  useEffect(() => {
    if (!hasLive) return;
    const timer = setInterval(() => {
      void m.client.filingJobs(m.orgId, m.businessId).then(setJobs, () => undefined);
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [m, hasLive]);

  const start = async (kindOf: FilingJob['kind'], form: string | undefined, forPeriod = fp) => {
    setBusy(true);
    try {
      await m.client.startFilingJob(m.orgId, {
        businessId: m.businessId,
        kind: kindOf,
        ...(form ? { form } : {}),
        period: forPeriod,
      });
      await load();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const mine = jobs.filter(
    (j) => j.period === fp || iffMonths(period).some((x) => x.fp === j.period),
  );
  const nil = desk['gstr1']?.nil ?? false;
  const filed = desk['gstr1']?.filed ?? false;
  const pushed = mine.some((j) => j.kind === 'push' && j.form === 'gstr1' && j.status === 'done');

  return (
    <div className="flex flex-col gap-3" data-testid="portal-tab">
      {nil && (
        <p
          role="note"
          className="rounded-md border border-border p-2 text-sm"
          data-testid="portal-nil"
        >
          {t('filing.nil')}
        </p>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        {(['gstr1', 'gstr3b'] as const).map((ret) => {
          const d = desk[ret];
          return d ? (
            <div key={ret} className="flex flex-col gap-0.5" data-testid={`desk-${ret}`}>
              <span className="font-medium">{t(`gst.${ret}`)}</span>
              <span className="text-fg-muted">{t('filing.due', { date: d.due })}</span>
              {d.lateFee.days > 0 && (
                <span className="text-warning" data-testid={`latefee-${ret}`}>
                  {t('filing.lateFee', {
                    days: d.lateFee.days,
                    fee: formatPaise(d.lateFee.feePaise),
                  })}
                </span>
              )}
              {d.lateFee.days > 0 && (
                <span className="text-xs text-fg-muted">{t('filing.lateFeeNote')}</span>
              )}
            </div>
          ) : null;
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="portal-push"
          disabled={busy || filed}
          onClick={() => void start('push', 'gstr1')}
        >
          {nil ? t('filing.pushNil') : t('filing.push')}
        </Button>
        <Button
          variant="secondary"
          data-testid="portal-pull-2b"
          disabled={busy}
          onClick={() => void start('pull_2b', undefined)}
        >
          {t('filing.pull2b')}
        </Button>
        <Button
          variant="secondary"
          data-testid="portal-pull-2a"
          disabled={busy}
          onClick={() => void start('pull_2a', undefined)}
        >
          {t('filing.pull2a')}
        </Button>
        <Button
          variant="outline"
          data-testid="portal-check"
          disabled={busy}
          onClick={() => void start('poll_filing', 'gstr1')}
        >
          {t('filing.checkFiled')}
        </Button>
      </div>

      {kind === 'quarter' && iffMonths(period).length > 0 && (
        <div className="flex flex-col gap-1 text-sm" data-testid="portal-iff">
          <span className="font-medium">{t('filing.iff.title')}</span>
          <span className="text-xs text-fg-muted">{t('filing.iff.help')}</span>
          <div className="flex flex-wrap gap-2">
            {iffMonths(period).map((x) => (
              <Button
                key={x.fp}
                variant="outline"
                data-testid={`portal-iff-${x.fp}`}
                disabled={busy}
                onClick={() => void start('push', 'iff', x.fp)}
              >
                {t('filing.iff.push', { month: x.fp.slice(0, 2), due: x.due })}
              </Button>
            ))}
          </div>
        </div>
      )}

      {mine.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" data-testid="portal-jobs">
          {mine.slice(0, 8).map((j) => (
            <li
              key={j.id}
              className="flex flex-col gap-0.5 border-b border-border py-1"
              data-testid="portal-job"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {t(dyn(`filing.job.${j.kind}`), {
                    form: (j.form ?? '').toUpperCase(),
                    period: j.period,
                  })}
                </span>
                <Badge tone={TONE[j.status] ?? 'info'} data-testid="portal-job-status">
                  {t(dyn(`filing.status.${j.status}`))}
                </Badge>
              </div>
              {j.error && <span className="text-xs text-danger">{j.error}</span>}
              <JobResult job={j} />
            </li>
          ))}
        </ul>
      )}

      {(pushed || filed) && !filed && (
        <ol className="list-decimal pl-5 text-sm text-fg-muted" data-testid="portal-steps">
          {(['s1', 's2', 's3', 's4'] as const).map((k) => (
            <li key={k}>{t(dyn(`filing.steps.${k}`))}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function JobResult({ job }: { job: FilingJob }) {
  const { t } = useTranslation();
  const r = job.result;
  if (!r) return null;
  const tables =
    (r['tables'] as
      | {
          table: string;
          status: string;
          count: number;
          errors: { code: string; message: string; ref?: string }[];
        }[]
      | undefined) ?? [];
  return (
    <div className="text-xs text-fg-muted">
      {tables.length > 0 && (
        <ul>
          {tables.map((x) => (
            <li key={x.table} data-testid="portal-table">
              {x.table}: {x.count}{' '}
              {x.errors.map((e) => `${e.ref ?? ''} ${e.message} (${e.code})`).join('; ')}
            </li>
          ))}
        </ul>
      )}
      {typeof r['imported'] === 'number' && (
        <span data-testid="portal-recon">
          {t('filing.recon', {
            imported: String(r['imported']),
            matched: String(r['matched'] ?? 0),
            diff: String(r['withDifferences'] ?? 0),
            only2b: String(r['onlyIn2b'] ?? 0),
          })}
        </span>
      )}
      {r['filed'] === true && (
        <span data-testid="portal-arn">{t('filing.arn', { arn: String(r['arn']) })}</span>
      )}
      {r['unchanged'] === true && <span>{t('filing.unchanged')}</span>}
    </div>
  );
}

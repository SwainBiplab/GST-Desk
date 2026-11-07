/**
 * Account and sync on the phone (prompt 43): sign in with a code sent to the phone number, pick the
 * organisation and the business, and the phone opens that business as a synced book (the first sync
 * shows its progress on the way in). Signing out forgets the session and the chosen business; the
 * local book, if any, is untouched.
 */
import { Button, Card, Input, toast } from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useOnline } from './layout';

import { useAppDb } from '@/app/db';
import {
  CloudClient,
  CloudError,
  isAllowedApiUrl,
  readCloudUrl,
  readSession,
  writeCloudUrl,
  writeSession,
  type CloudBusiness,
  type CloudMe,
  type CloudSession,
} from '@/features/cloud/client';
import { readCloudBook, writeCloudBook } from '@/features/sync/book';
import { useSyncStatus } from '@/features/sync/status';
import { browserStore } from '@/features/team/source';
import { isNativeApp } from '@/platform';

const store = {
  get: browserStore.get,
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage blocked */
    }
  },
};

const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);

export function AccountScreen() {
  const { t } = useTranslation();
  const { cloudBook } = useAppDb();
  const online = useOnline();
  const sync = useSyncStatus();
  const [url, setUrl] = useState(
    () => readCloudUrl(store.get) || (import.meta.env['VITE_API_URL'] ?? ''),
  );
  const [session, setSession] = useState<CloudSession | null>(() => readSession(store.get));
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'idle' | 'code'>('idle');
  const [devHint, setDevHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<CloudMe | null>(null);
  const [orgId, setOrgId] = useState('');
  const [businesses, setBusinesses] = useState<CloudBusiness[]>([]);
  const chosen = readCloudBook(store.get);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!session) return;
    const c = new CloudClient(session.baseUrl, session.token);
    void c
      .me()
      .then((m) => {
        setMe(m);
        setOrgId((cur) => cur || chosen?.orgId || m.organisations[0]?.id || '');
      })
      .catch(() => undefined);
  }, [session, chosen?.orgId]);

  useEffect(() => {
    if (!session || !orgId) return;
    void new CloudClient(session.baseUrl, session.token)
      .businesses(orgId)
      .then(setBusinesses)
      .catch(() => setBusinesses([]));
  }, [session, orgId]);

  const sendCode = () =>
    run(async () => {
      if (!isAllowedApiUrl(url)) throw new Error(t('cloud.badUrl'));
      writeCloudUrl(store.set, url);
      const c = new CloudClient(url.trim().replace(/\/$/, ''));
      await c.sendPhoneCode(phone.trim());
      setStep('code');
      try {
        setDevHint((await c.devCode(phone.trim())).code);
      } catch {
        setDevHint(null);
      }
    });

  const signIn = () =>
    run(async () => {
      const base = url.trim().replace(/\/$/, '');
      const c = new CloudClient(base);
      const token = await c.signInWithPhoneCode(phone.trim(), code.trim());
      const s: CloudSession = { baseUrl: base, token, email: phone.trim(), signedInAt: Date.now() };
      writeSession(store.set, s);
      setSession(s);
      setStep('idle');
      setCode('');
      toast.success(t('cloud.signedIn'));
    });

  const pickBusiness = (b: CloudBusiness) =>
    run(async () => {
      if (!me) return;
      const org = me.organisations.find((o) => o.id === orgId);
      writeCloudBook(store.set, {
        orgId,
        orgName: org?.name ?? '',
        businessId: b.id,
        businessName: b.tradeName ?? b.legalName,
        userId: me.user.id,
      });
      toast.success(t('mobile.account.chosen', { name: b.tradeName ?? b.legalName }));
      // the book is opened when the app starts: start again on it
      window.location.replace('/shop/dashboard');
    });

  const signOut = () =>
    run(async () => {
      if (session)
        await new CloudClient(session.baseUrl, session.token).signOut().catch(() => undefined);
      writeSession(store.set, null);
      writeCloudBook(store.set, null);
      setSession(null);
      setMe(null);
      window.location.replace('/shop/dashboard');
    });

  const pct = sync.progress ? Math.round(sync.progress.fraction * 100) : null;

  return (
    <div className="flex flex-col gap-3" data-testid="account-screen">
      <h1 className="text-lg font-semibold">{t('mobile.account.title')}</h1>
      {!online && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-sm" data-testid="account-offline">
          {t('mobile.account.offline')}
        </p>
      )}
      {!session ? (
        <Card className="flex flex-col gap-2 p-3" data-testid="account-sign-in">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('cloud.urlPlaceholder')}
            aria-label={t('cloud.url')}
            data-testid="account-url"
            inputMode="url"
            className="min-h-12"
          />
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t('mobile.account.phonePlaceholder')}
            aria-label={t('mobile.account.phone')}
            data-testid="account-phone"
            inputMode="tel"
            className="min-h-12"
            disabled={step === 'code'}
          />
          {step === 'idle' ? (
            <Button
              className="min-h-12"
              data-testid="account-send-code"
              disabled={busy || !phone.trim()}
              onClick={() => void sendCode()}
            >
              {t('mobile.account.sendCode')}
            </Button>
          ) : (
            <>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('mobile.account.code')}
                aria-label={t('mobile.account.code')}
                data-testid="account-code"
                inputMode="numeric"
                className="min-h-12"
              />
              {devHint && (
                <p className="text-xs text-fg-muted" data-testid="account-dev-code">
                  {t('cloud.devCode', { code: devHint })}
                </p>
              )}
              <Button
                className="min-h-12"
                data-testid="account-sign-in-button"
                disabled={busy || !code.trim()}
                onClick={() => void signIn()}
              >
                {t('mobile.account.signIn')}
              </Button>
            </>
          )}
        </Card>
      ) : (
        <>
          <Card className="p-3">
            <p className="text-sm" data-testid="account-signed-in">
              {t('mobile.more.signedInAs', { who: me?.user.name || session.email })}
            </p>
            {!isNativeApp() && (
              <p className="pt-1 text-xs text-fg-muted" data-testid="account-web-note">
                {t('mobile.account.syncNeedsPhone')}
              </p>
            )}
            {cloudBook && (
              <div className="pt-2" data-testid="account-sync">
                <p className="text-sm">
                  {t('mobile.more.syncingBusiness', {
                    name: cloudBook.businessName,
                    org: cloudBook.orgName,
                  })}
                </p>
                <div className="mt-1 h-2 overflow-hidden rounded bg-surface-2">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${pct ?? (sync.lastSyncedAt ? 100 : 0)}%` }}
                  />
                </div>
                <p className="text-xs text-fg-muted">
                  {sync.progress
                    ? t('mobile.account.progress', {
                        done: sync.progress.done,
                        total: sync.progress.total,
                      })
                    : sync.lastSyncedAt
                      ? t('mobile.account.syncedAll', {
                          when: new Date(sync.lastSyncedAt).toLocaleTimeString('en-IN'),
                        })
                      : t('mobile.account.connecting')}
                </p>
              </div>
            )}
          </Card>
          <Card className="p-3">
            <h2 className="text-sm font-medium">{t('mobile.account.organisations')}</h2>
            {me?.organisations.length === 0 && (
              <p className="text-sm text-fg-muted">{t('mobile.account.noOrgs')}</p>
            )}
            <ul className="flex flex-wrap gap-2 pt-2">
              {me?.organisations.map((o) => (
                <li key={o.id}>
                  <Button
                    variant={o.id === orgId ? 'primary' : 'outline'}
                    data-testid="account-org"
                    onClick={() => setOrgId(o.id)}
                  >
                    {o.name}
                  </Button>
                </li>
              ))}
            </ul>
            {orgId && (
              <>
                <h2 className="pt-3 text-sm font-medium">{t('mobile.account.businesses')}</h2>
                {businesses.length === 0 && (
                  <p className="text-sm text-fg-muted">{t('mobile.account.noBusinesses')}</p>
                )}
                <ul className="divide-y divide-border">
                  {businesses.map((b) => (
                    <li key={b.id} className="flex min-h-12 items-center justify-between gap-2">
                      <span className="truncate text-sm">{b.tradeName ?? b.legalName}</span>
                      {chosen?.businessId === b.id ? (
                        <span className="text-xs text-fg-muted">{t('mobile.account.inUse')}</span>
                      ) : (
                        <Button
                          variant="secondary"
                          data-testid="account-use-business"
                          disabled={busy || !isNativeApp()}
                          onClick={() => void pickBusiness(b)}
                        >
                          {t('mobile.account.useBusiness')}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
          <Button
            variant="ghost"
            data-testid="account-sign-out"
            disabled={busy}
            onClick={() => void signOut()}
          >
            {t('mobile.account.signOut')}
          </Button>
        </>
      )}
    </div>
  );
}

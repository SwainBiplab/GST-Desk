/**
 * Settings, Cloud: the API address, sign in with a one-time code (email), the organisations the person
 * belongs to, make one, and make a business in it. Sync of the books arrives with prompt 41; this tab
 * proves the account and the organisation exist on the server.
 */
import { STATES } from '@gst/domain';
import {
  Badge,
  Button,
  Card,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
} from './client';

import { useAppDb } from '@/app/db';

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage may be blocked */
    }
  },
};

const errText = (e: unknown) =>
  e instanceof CloudError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);

export function CloudTab() {
  const { t } = useTranslation();
  const { business } = useAppDb();
  const [url, setUrl] = useState(() => readCloudUrl(store.get));
  const [session, setSession] = useState<CloudSession | null>(() => readSession(store.get));
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'idle' | 'code'>('idle');
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<CloudMe | null>(null);
  const [orgName, setOrgName] = useState('');
  const [orgId, setOrgId] = useState<string>('');
  const [businesses, setBusinesses] = useState<CloudBusiness[]>([]);
  const [devHint, setDevHint] = useState<string | null>(null);

  const client = () => new CloudClient(session?.baseUrl ?? url, session?.token ?? null);

  const refresh = async (s: CloudSession | null = session) => {
    if (!s) return;
    try {
      const m = await new CloudClient(s.baseUrl, s.token).me();
      setMe(m);
      const first = m.organisations[0]?.id ?? '';
      setOrgId((cur) => cur || first);
    } catch (e) {
      if (e instanceof CloudError && e.status === 401) {
        writeSession(store.set, null);
        setSession(null);
        setMe(null);
      } else toast.error(errText(e));
    }
  };

  // once on mount, for a session kept from last time; a dead token is forgotten
  useEffect(() => {
    const s = readSession(store.get);
    if (!s) return;
    let live = true;
    new CloudClient(s.baseUrl, s.token)
      .me()
      .then((m) => {
        if (!live) return;
        setMe(m);
        setOrgId((cur) => cur || (m.organisations[0]?.id ?? ''));
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof CloudError && e.status === 401) {
          writeSession(store.set, null);
          setSession(null);
        } else toast.error(errText(e));
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!session || !orgId) return;
    let live = true;
    void new CloudClient(session.baseUrl, session.token)
      .businesses(orgId)
      .then((b) => live && setBusinesses(b))
      .catch(() => live && setBusinesses([]));
    return () => {
      live = false;
    };
  }, [session, orgId]);

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

  const sendCode = () =>
    run(async () => {
      if (!isAllowedApiUrl(url)) throw new Error(t('cloud.badUrl'));
      writeCloudUrl(store.set, url);
      const c = new CloudClient(url);
      await c.sendEmailCode(email.trim());
      setStep('code');
      // a development server hands the code back; a real one sends it
      try {
        const d = await c.devCode(email.trim());
        setDevHint(d.code);
      } catch {
        setDevHint(null);
      }
    });

  const signIn = () =>
    run(async () => {
      const c = new CloudClient(url);
      const token = await c.signInWithEmailCode(email.trim(), code.trim());
      const s: CloudSession = { baseUrl: url, token, email: email.trim(), signedInAt: Date.now() };
      writeSession(store.set, s);
      setSession(s);
      setStep('idle');
      setCode('');
      setDevHint(null);
      await refresh(s);
      toast.success(t('cloud.signedIn'));
    });

  const signOut = () =>
    run(async () => {
      await client()
        .signOut()
        .catch(() => undefined);
      writeSession(store.set, null);
      setSession(null);
      setMe(null);
      setBusinesses([]);
    });

  const createOrg = () =>
    run(async () => {
      const o = await client().createOrganisation(orgName.trim());
      setOrgName('');
      await refresh();
      setOrgId(o.id);
      toast.success(t('cloud.orgCreated', { name: o.name }));
    });

  const createBusiness = () =>
    run(async () => {
      if (!business) throw new Error(t('cloud.noLocalBusiness'));
      const b = await client().createBusiness(orgId, {
        legalName: String(business['legal_name']),
        stateCode: String(business['state_code']),
        ...(business['gstin'] ? { gstin: String(business['gstin']) } : {}),
        scheme: business['scheme'] === 'composition' ? 'composition' : 'regular',
      });
      setBusinesses((cur) => [...cur, b]);
      toast.success(t('cloud.businessCreated', { name: b.legalName }));
    });

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="cloud-tab">
      <Card>
        <h2 className="font-medium">{t('cloud.title')}</h2>
        <p className="text-sm text-fg-muted">{t('cloud.intro')}</p>
        {!session ? (
          <div className="flex flex-col gap-3 pt-3 text-sm">
            <label className="flex flex-col gap-1">
              {t('cloud.url')}
              <Input
                className="w-96"
                value={url}
                placeholder={t('cloud.urlPlaceholder')}
                data-testid="cloud-url"
                onChange={(e) => setUrl(e.target.value)}
                disabled={step === 'code'}
              />
            </label>
            <label className="flex flex-col gap-1">
              {t('cloud.email')}
              <Input
                className="w-96"
                type="email"
                value={email}
                data-testid="cloud-email"
                onChange={(e) => setEmail(e.target.value)}
                disabled={step === 'code'}
              />
            </label>
            {step === 'idle' ? (
              <Button
                className="self-start"
                data-testid="cloud-send-code"
                disabled={busy || !email.trim() || !url.trim()}
                onClick={() => void sendCode()}
              >
                {t('cloud.sendCode')}
              </Button>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  {t('cloud.code')}
                  <Input
                    className="w-40 font-mono"
                    inputMode="numeric"
                    value={code}
                    data-testid="cloud-code"
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                {devHint && (
                  <p className="text-xs text-fg-muted" data-testid="cloud-dev-code">
                    {t('cloud.devCode', { code: devHint })}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    data-testid="cloud-sign-in"
                    disabled={busy || code.trim().length < 4}
                    onClick={() => void signIn()}
                  >
                    {t('cloud.signIn')}
                  </Button>
                  <Button variant="ghost" onClick={() => setStep('idle')}>
                    {t('confirm.cancel')}
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3 pt-3 text-sm">
            <Badge tone="success">{t('cloud.signedInAs', { email: session.email })}</Badge>
            <span className="text-fg-muted">{session.baseUrl}</span>
            <Button
              variant="ghost"
              data-testid="cloud-sign-out"
              disabled={busy}
              onClick={() => void signOut()}
            >
              {t('cloud.signOut')}
            </Button>
          </div>
        )}
        <p className="pt-3 text-xs text-fg-muted">{t('cloud.tokenNote')}</p>
      </Card>

      {session && me && (
        <Card>
          <h2 className="font-medium">{t('cloud.orgs.title')}</h2>
          {me.organisations.length === 0 ? (
            <p className="py-2 text-sm text-fg-muted">{t('cloud.orgs.none')}</p>
          ) : (
            <div className="flex items-center gap-3 py-2 text-sm">
              <Select value={orgId} onValueChange={setOrgId}>
                <SelectTrigger
                  className="w-72"
                  data-testid="cloud-org"
                  aria-label={t('cloud.orgs.title')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {me.organisations.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {`${o.name} · ${o.role}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-end gap-2 pt-2 text-sm">
            <label className="flex flex-col gap-1">
              {t('cloud.orgs.newName')}
              <Input
                className="w-72"
                value={orgName}
                data-testid="cloud-org-name"
                onChange={(e) => setOrgName(e.target.value)}
              />
            </label>
            <Button
              variant="secondary"
              data-testid="cloud-org-create"
              disabled={busy || !orgName.trim()}
              onClick={() => void createOrg()}
            >
              {t('cloud.orgs.create')}
            </Button>
          </div>
        </Card>
      )}

      {session && orgId && (
        <Card>
          <h2 className="font-medium">{t('cloud.businesses.title')}</h2>
          {businesses.length === 0 ? (
            <p className="py-2 text-sm text-fg-muted">{t('cloud.businesses.none')}</p>
          ) : (
            <ul className="divide-y divide-border text-sm" data-testid="cloud-businesses">
              {businesses.map((b) => (
                <li key={b.id} className="flex items-center gap-3 py-2">
                  <span className="font-medium">{b.legalName}</span>
                  <span className="text-fg-muted">
                    {STATES[b.stateCode as keyof typeof STATES] ?? b.stateCode}
                  </span>
                  {b.gstin && <span className="font-mono text-xs">{b.gstin}</span>}
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="secondary"
            className="mt-2"
            data-testid="cloud-business-create"
            disabled={busy || !business}
            onClick={() => void createBusiness()}
          >
            {t('cloud.businesses.createFromLocal', {
              name: String(business?.['legal_name'] ?? ''),
            })}
          </Button>
          <p className="pt-2 text-xs text-fg-muted">{t('cloud.businesses.syncNote')}</p>
        </Card>
      )}
    </div>
  );
}

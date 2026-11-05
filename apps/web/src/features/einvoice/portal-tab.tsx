import { EinvoiceRepo, type GspConfig } from '@gst/db';
import { today } from '@gst/domain';
import { WrongPinError, pinProblem } from '@gst/gsp';
import {
  Button,
  Card,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  formatPaise,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePortalSettings } from './hooks';
import { lock, resetClients, saveCredentials, unlock, useUnlocked } from './session';

import { useAppDb } from '@/app/db';
import { dyn } from '@/lib/dyn-key';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings, GST portal: e-invoicing on or off, which GSP, and the sealed portal logins. */
export function PortalTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const day = today(() => new Date());
  const s = usePortalSettings(day);
  const unlocked = useUnlocked(ctx?.businessId ?? null);
  // what is being edited; until something is changed the saved settings show
  const [edit, setCfg] = useState<GspConfig | null>(null);
  const [creds, setCreds] = useState({
    einvUser: '',
    einvPassword: '',
    ewbUser: '',
    ewbPassword: '',
    clientId: '',
    clientSecret: '',
  });
  const [pin, setPin] = useState('');
  const [unlockPin, setUnlockPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!s || !database || !ctx) return null;
  const cfg = edit ?? s.cfg;
  const repo = new EinvoiceRepo(database);
  const guard = async (fn: () => Promise<void>, ok?: string) => {
    setError(null);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e) {
      setError(e instanceof WrongPinError ? t('einv.portal.wrongPin') : msg(e));
    }
  };
  const input = (label: string, key: keyof typeof creds, type = 'text') => (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <Input
        type={type}
        autoComplete="off"
        data-testid={`cred-${key}`}
        value={creds[key]}
        onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
      />
    </label>
  );
  const vendor = cfg.mode === 'vendor-x';

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="portal-tab">
      <Card>
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch
            checked={s.on}
            data-testid="einv-switch"
            onCheckedChange={(on) => void repo.setEinvoicing(ctx, on)}
          />
          {t('einv.portal.on')}
        </label>
        <p className="pt-2 text-sm text-fg-muted" data-testid="einv-turnover">
          {t('einv.turnoverHint', { amount: formatPaise(s.turnoverPaise) })}
        </p>
        <p className="pt-1 text-xs text-fg-muted">{t('einv.beta')}</p>
      </Card>

      <Card>
        <h2 className="font-medium">{t('einv.portal.mode')}</h2>
        <div className="flex flex-col gap-3 pt-2">
          <Select
            value={cfg.mode}
            onValueChange={(v) => setCfg({ ...cfg, mode: v as GspConfig['mode'] })}
          >
            <SelectTrigger data-testid="gsp-mode" aria-label={t('einv.portal.mode')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['practice', 'vendor-x'] as const).map((m) => (
                <SelectItem key={m} value={m}>
                  {t(dyn(`einv.portal.modes.${m}`))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {vendor && (
            <>
              <label className="flex flex-col gap-1 text-sm font-medium">
                {t('einv.portal.baseUrl')}
                <Input
                  data-testid="gsp-url"
                  value={cfg.baseUrl ?? ''}
                  onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={cfg.sandbox}
                  onCheckedChange={(v) => setCfg({ ...cfg, sandbox: v })}
                />
                {t('einv.portal.sandbox')}
              </label>
            </>
          )}
          {!vendor && <p className="text-xs text-fg-muted">{t('einv.portal.practiceNoCreds')}</p>}
          <div>
            <Button
              data-testid="gsp-save"
              onClick={() =>
                void guard(async () => {
                  await repo.setGspConfig(ctx, cfg);
                  resetClients();
                }, t('einv.portal.configSaved'))
              }
            >
              {t('einv.portal.saveConfig')}
            </Button>
          </div>
        </div>
      </Card>

      {vendor && (
        <Card>
          <h2 className="font-medium">{t('einv.portal.creds')}</h2>
          <p className="py-2 text-sm text-fg-muted">{t('einv.portal.credsHint')}</p>
          <p className="pb-2 text-sm" data-testid="creds-state">
            {unlocked
              ? t('einv.portal.unlocked')
              : s.hasCredentials
                ? t('einv.portal.locked')
                : t('einv.portal.none')}
          </p>
          {s.hasCredentials && !unlocked && (
            <div className="flex items-end gap-2 pb-3">
              <label className="flex flex-col gap-1 text-sm font-medium">
                {t('einv.portal.unlockPin')}
                <Input
                  type="password"
                  data-testid="unlock-pin"
                  value={unlockPin}
                  onChange={(e) => setUnlockPin(e.target.value)}
                />
              </label>
              <Button
                data-testid="unlock"
                onClick={() =>
                  void guard(async () => {
                    await unlock(database, ctx, unlockPin);
                    setUnlockPin('');
                  })
                }
              >
                {t('einv.portal.unlock')}
              </Button>
            </div>
          )}
          {unlocked && (
            <Button
              variant="outline"
              className="mb-3"
              data-testid="lock"
              onClick={() => lock(ctx.businessId)}
            >
              {t('einv.portal.lock')}
            </Button>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {input(t('einv.portal.einvUser'), 'einvUser')}
            {input(t('einv.portal.einvPassword'), 'einvPassword', 'password')}
            {input(t('einv.portal.ewbUser'), 'ewbUser')}
            {input(t('einv.portal.ewbPassword'), 'ewbPassword', 'password')}
            {input(t('einv.portal.clientId'), 'clientId')}
            {input(t('einv.portal.clientSecret'), 'clientSecret', 'password')}
          </div>
          <label className="flex flex-col gap-1 pt-3 text-sm font-medium">
            {t('einv.portal.pin')}
            <Input
              type="password"
              data-testid="cred-pin"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </label>
          <p className="pt-1 text-xs text-fg-muted">{t('einv.portal.keep')}</p>
          <div className="pt-3">
            <Button
              data-testid="cred-save"
              onClick={() =>
                void guard(async () => {
                  const problem = pinProblem(pin);
                  if (problem) throw new Error(problem);
                  const clean = Object.fromEntries(
                    Object.entries(creds).filter(([, v]) => v.trim() !== ''),
                  );
                  await saveCredentials(database, ctx, clean, pin);
                  setCreds({
                    einvUser: '',
                    einvPassword: '',
                    ewbUser: '',
                    ewbPassword: '',
                    clientId: '',
                    clientSecret: '',
                  });
                  setPin('');
                }, t('einv.portal.saved'))
              }
            >
              {t('einv.portal.save')}
            </Button>
          </div>
        </Card>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger" data-testid="portal-error">
          {error}
        </p>
      )}
    </div>
  );
}

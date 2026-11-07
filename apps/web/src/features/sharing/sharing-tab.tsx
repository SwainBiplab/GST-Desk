/**
 * Settings, Accountant and customers (prompt 47): share this business read-only with an accountant for a
 * financial year (and revoke it), and turn the customer pages on with their defaults. Both live on the cloud,
 * so the tab needs a signed-in session and a business the server knows.
 */
import { can } from '@gst/domain';
import { Badge, Button, Card, Checkbox, Input, Switch, Textarea, toast } from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CloudError,
  type PortalSettings,
  type SharePerms,
  type ShareView,
} from '@/features/cloud/client';
import { useMessaging, type Messaging } from '@/features/dispatch/use-messaging';
import { usePermissions } from '@/features/team/permissions';
import { dyn } from '@/lib/dyn-key';

const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);
const PERM_KEYS = ['read', 'gst', 'export', 'comment'] as const;

export function SharingTab() {
  const { t } = useTranslation();
  const state = useMessaging();
  if (state.kind !== 'ready')
    return (
      <Card className="max-w-3xl p-4" data-testid="sharing-unavailable">
        <p className="text-sm">{t(dyn(`dispatch.unavailable.${state.kind}`))}</p>
      </Card>
    );
  return (
    <div className="flex max-w-4xl flex-col gap-4" data-testid="sharing-tab">
      <ShareCard m={state.m} />
      <PortalSettingsCard m={state.m} />
    </div>
  );
}

function ShareCard({ m }: { m: Messaging }) {
  const { t } = useTranslation();
  const { perms } = usePermissions();
  const [shares, setShares] = useState<ShareView[] | null>(null);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [fy, setFy] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [grant, setGrant] = useState<SharePerms>({
    read: true,
    gst: true,
    export: true,
    comment: true,
  });
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const mayShare = can(perms, 'team', 'create');

  useEffect(() => {
    let live = true;
    void m.client.shares(m.orgId, m.businessId).then(
      (rows) => live && setShares(rows),
      (e: unknown) => live && toast.error(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [m, version]);

  const share = async () => {
    setBusy(true);
    try {
      await m.client.share(m.orgId, {
        businessId: m.businessId,
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(fy.trim() ? { fy: fy.trim() } : { from, to }),
        perms: grant,
        note: note.trim() || null,
      });
      toast.success(t('sharing.shared'));
      setEmail('');
      setPhone('');
      setNote('');
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    try {
      await m.client.revokeShare(m.orgId, id);
      toast.success(t('sharing.revoked'));
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const ready = (email.trim() || phone.trim()) && (fy.trim() || (from && to));

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="share-card">
      <h2 className="font-medium">{t('sharing.title')}</h2>
      <p className="text-sm text-fg-muted">{t('sharing.help')}</p>
      {mayShare && (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            {t('sharing.email')}
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="share-email"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('sharing.phone')}
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              data-testid="share-phone"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('sharing.fy')}
            <Input
              value={fy}
              placeholder={t('sharing.fyFormat')}
              onChange={(e) => setFy(e.target.value)}
              data-testid="share-fy"
            />
          </label>
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              {t('sharing.from')}
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              {t('sharing.to')}
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <div className="flex flex-col gap-1 text-sm md:col-span-2">
            {PERM_KEYS.map((k) => (
              <label key={k} className="flex items-center gap-2">
                <Checkbox
                  checked={grant[k]}
                  onCheckedChange={(v) => setGrant((g) => ({ ...g, [k]: v === true }))}
                  data-testid={`share-perm-${k}`}
                />
                {t(dyn(`sharing.perms.${k}`))}
              </label>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            {t('sharing.note')}
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </label>
          <div>
            <Button
              onClick={() => void share()}
              disabled={busy || !ready}
              data-testid="share-submit"
            >
              {t('sharing.share')}
            </Button>
          </div>
        </div>
      )}
      <h3 className="pt-2 text-sm font-medium">{t('sharing.list')}</h3>
      {shares && shares.length === 0 && (
        <p className="text-sm text-fg-muted" data-testid="shares-none">
          {t('sharing.none')}
        </p>
      )}
      <ul className="flex flex-col gap-2 text-sm">
        {(shares ?? []).map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-2"
            data-testid="share-row"
            data-status={s.status}
          >
            <span className="font-medium">{s.email}</span>
            <span className="text-fg-muted">{t('sharing.span', { from: s.from, to: s.to })}</span>
            <Badge
              tone={s.status === 'active' ? 'success' : s.status === 'pending' ? 'info' : 'neutral'}
            >
              {t(dyn(`sharing.status.${s.status}`))}
            </Badge>
            <span className="text-xs text-fg-muted">
              {PERM_KEYS.filter((k) => s.perms[k])
                .map((k) => t(dyn(`sharing.perms.${k}`)))
                .join(' · ')}
            </span>
            {mayShare && (s.status === 'pending' || s.status === 'active') && (
              <Button
                variant="outline"
                onClick={() => void revoke(s.id)}
                data-testid="share-revoke"
              >
                {t('sharing.revoke')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PortalSettingsCard({ m }: { m: Messaging }) {
  const { t } = useTranslation();
  const { perms } = usePermissions();
  const [s, setS] = useState<PortalSettings | null>(null);
  const [days, setDays] = useState('');
  const mayEdit = can(perms, 'settings', 'edit');

  useEffect(() => {
    let live = true;
    void m.client.portalSettings(m.orgId, m.businessId).then(
      (v) => {
        if (!live) return;
        setS(v);
        setDays(String(v.linkDays));
      },
      (e: unknown) => live && toast.error(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [m]);

  const save = async (patch: Partial<PortalSettings>) => {
    try {
      const next = await m.client.savePortalSettings(m.orgId, {
        businessId: m.businessId,
        ...patch,
      });
      setS(next);
      setDays(String(next.linkDays));
      toast.success(t('portal.settings.saved'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  if (!s) return null;
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="portal-settings">
      <h2 className="font-medium">{t('portal.settings.title')}</h2>
      <p className="text-sm text-fg-muted">{t('portal.settings.help')}</p>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={s.enabled}
          disabled={!mayEdit}
          onCheckedChange={(v) => void save({ enabled: v })}
          data-testid="portal-enabled"
        />
        {t('portal.settings.enabled')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={s.statements}
          disabled={!mayEdit}
          onCheckedChange={(v) => void save({ statements: v })}
          data-testid="portal-statements"
        />
        {t('portal.settings.statements')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={s.questions}
          disabled={!mayEdit}
          onCheckedChange={(v) => void save({ questions: v })}
          data-testid="portal-questions"
        />
        {t('portal.settings.questions')}
      </label>
      <label className="flex max-w-xs flex-col gap-1 text-sm">
        {t('portal.settings.linkDays')}
        <Input
          type="number"
          min={1}
          max={730}
          value={days}
          disabled={!mayEdit}
          onChange={(e) => setDays(e.target.value)}
          onBlur={() => {
            const n = Math.max(1, Math.min(730, Number(days) || s.linkDays));
            if (n !== s.linkDays) void save({ linkDays: n });
          }}
          data-testid="portal-link-days"
        />
      </label>
    </Card>
  );
}

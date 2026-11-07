/**
 * Settings, AI: the cloud tier (prompt 48). Off until the business opts in; then either our gateway on the
 * cloud plan (with the month's tokens shown) or, on the desktop, the person's own key kept in the operating
 * system's keychain. "Why cloud?" and the data-handling note sit beside the switch, and the option to be asked
 * before every scan or question.
 */
import { Button, Card, Input, RadioGroup, RadioGroupItem, Switch, toast } from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CloudError, type AiQuota } from '../cloud/client';
import { isDesktop, secretDelete, secretGet, secretSet } from '../desktop/bridge';
import { useMessaging } from '../dispatch/use-messaging';

import { BYOK_SECRET } from './cloud';
import type { AiSettings, CloudMode } from './settings';

const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);

export function CloudAiCard({
  s,
  save,
}: {
  s: AiSettings;
  save: (patch: Partial<AiSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const cloud = useMessaging();
  const [quota, setQuota] = useState<AiQuota | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [key, setKey] = useState('');
  const desktop = isDesktop();
  const m = cloud.kind === 'ready' ? cloud.m : null;

  useEffect(() => {
    if (!m || !s.cloud.enabled || s.cloud.mode !== 'gateway') return;
    let live = true;
    void m.client.aiStatus(m.orgId).then(
      (q) => live && setQuota(q),
      () => live && setQuota(null),
    );
    return () => {
      live = false;
    };
  }, [m, s.cloud.enabled, s.cloud.mode]);

  useEffect(() => {
    if (!desktop) return;
    void secretGet(BYOK_SECRET).then(
      (v) => setHasKey(!!v),
      () => setHasKey(false),
    );
  }, [desktop]);

  const setCloud = (patch: Partial<AiSettings['cloud']>) =>
    save({ cloud: { ...s.cloud, ...patch } });
  const saveKey = async () => {
    try {
      await secretSet(BYOK_SECRET, key.trim());
      setKey('');
      setHasKey(true);
      toast.success(t('ai.cloud.keySaved'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const forgetKey = async () => {
    try {
      await secretDelete(BYOK_SECRET);
      setHasKey(false);
      toast.success(t('ai.cloud.keyForgotten'));
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <Card data-testid="ai-cloud">
      <h2 className="font-medium">{t('ai.cloud.title')}</h2>
      <p className="text-sm text-fg-muted">{t('ai.cloud.intro')}</p>
      <label className="flex items-center gap-2 py-3 text-sm">
        <Switch
          checked={s.cloud.enabled}
          onCheckedChange={(v) => void setCloud({ enabled: v })}
          data-testid="ai-cloud-enabled"
        />
        {t('ai.cloud.enable')}
      </label>
      {s.cloud.enabled && (
        <div className="flex flex-col gap-3 text-sm">
          <RadioGroup
            value={s.cloud.mode}
            onValueChange={(v) => void setCloud({ mode: v as CloudMode })}
            className="flex flex-col gap-2"
            aria-label={t('ai.cloud.mode')}
          >
            {(['gateway', 'byok'] as const).map((mode) => {
              const disabled = mode === 'byok' && !desktop;
              return (
                <label
                  key={mode}
                  htmlFor={`ai-cloud-${mode}`}
                  className={`flex items-start gap-2 ${disabled ? 'opacity-50' : ''}`}
                >
                  <RadioGroupItem
                    id={`ai-cloud-${mode}`}
                    value={mode}
                    disabled={disabled}
                    data-testid={`ai-cloud-${mode}`}
                  />
                  <span>
                    <span className="font-medium">{t(`ai.cloud.${mode}.label` as never)}</span>
                    <span className="block text-fg-muted">
                      {t(`ai.cloud.${mode}.help` as never)}
                    </span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>
          {s.cloud.mode === 'gateway' && (
            <p className="text-fg-muted" data-testid="ai-cloud-status">
              {cloud.kind !== 'ready'
                ? t(`dispatch.unavailable.${cloud.kind}` as never)
                : quota
                  ? quota.enabled
                    ? t('ai.cloud.quota', {
                        used: quota.used.toLocaleString('en-IN'),
                        limit: quota.limit.toLocaleString('en-IN'),
                      }) + (quota.warning ? ` ${t('ai.cloud.quotaWarning')}` : '')
                    : quota.configured
                      ? t('ai.cloud.notOnPlan')
                      : t('ai.cloud.notConfigured')
                  : t('ai.cloud.checking')}
            </p>
          )}
          {s.cloud.mode === 'byok' && desktop && (
            <div className="flex flex-col gap-2">
              <p className="text-fg-muted">{t('ai.cloud.byok.where')}</p>
              {hasKey ? (
                <div className="flex items-center gap-2">
                  <span data-testid="ai-cloud-key-saved">{t('ai.cloud.keyPresent')}</span>
                  <Button variant="outline" onClick={() => void forgetKey()}>
                    {t('ai.cloud.forgetKey')}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col">
                    {t('ai.cloud.key')}
                    <Input
                      type="password"
                      className="w-80"
                      value={key}
                      autoComplete="off"
                      onChange={(e) => setKey(e.target.value)}
                      data-testid="ai-cloud-key"
                    />
                  </label>
                  <Button
                    onClick={() => void saveKey()}
                    disabled={!key.trim().startsWith('sk-ant-')}
                  >
                    {t('ai.cloud.saveKey')}
                  </Button>
                </div>
              )}
            </div>
          )}
          <label className="flex items-center gap-2">
            <Switch
              checked={s.cloud.askEachTime}
              onCheckedChange={(v) => void setCloud({ askEachTime: v })}
              data-testid="ai-cloud-ask"
            />
            {t('ai.cloud.askEachTime')}
          </label>
          <details className="text-fg-muted">
            <summary className="cursor-pointer">{t('ai.cloud.why.title')}</summary>
            <p className="pt-1">{t('ai.cloud.why.body')}</p>
          </details>
          <p className="text-xs text-fg-muted" data-testid="ai-cloud-data-note">
            {t('ai.cloud.dataNote')}
          </p>
        </div>
      )}
    </Card>
  );
}

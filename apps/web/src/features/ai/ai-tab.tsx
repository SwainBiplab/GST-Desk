/**
 * Settings, AI: which backend answers (rules only, the built-in offline models, a user-run Ollama, or
 * the browser's GPU), and the offline models: what this computer can run, what is downloaded, each
 * model's size and licence, pause and resume, delete, disk use. Nothing is downloaded until a licence is
 * accepted and the button pressed.
 */
import {
  bundleFor,
  fits,
  type DeviceClass,
  type Hardware,
  type ModelEntry,
  type ModelKind,
} from '@gst/ai';
import { indexHsnMaster } from '@gst/ai/db';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isDesktop } from '../desktop/bridge';

import {
  detectHardware,
  deviceClassOf,
  loadManifest,
  modelManager,
  platformOf,
  useModelStates,
  type ManifestLoad,
} from './models';
import { embedderFor } from './router';
import { saveAiSettings, useAiSettings, type AiSettings, type Tier1Choice } from './settings';

import { useAppDb } from '@/app/db';
import { resetHybridHsn } from '@/lib/ai';

const GB = 2 ** 30;
const size = (bytes: number) =>
  bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${Math.round(bytes / 2 ** 20)} MB`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AiTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const settings = useAiSettings();
  const states = useModelStates();
  const [hw, setHw] = useState<Hardware | null>(null);
  const [manifest, setManifest] = useState<ManifestLoad | null>(null);
  const [manifestUrl, setManifestUrl] = useState<string | null>(null);
  const [licence, setLicence] = useState<ModelEntry | null>(null);
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(null);
  const [ollama, setOllama] = useState<string[] | null>(null);
  const s = settings.data;
  const m = modelManager();

  useEffect(() => {
    void detectHardware().then(setHw);
  }, []);
  useEffect(() => {
    if (!s || manifest) return;
    void loadManifest(s.manifestUrl).then(setManifest);
  }, [s, manifest]);

  const save = async (patch: Partial<AiSettings>) => {
    if (!database || !ctx) return;
    try {
      await saveAiSettings(database, ctx, patch);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const download = async (e: ModelEntry) => {
    try {
      const st = m.get(e.id);
      if (!st?.licenceAcceptedAt) return setLicence(e);
      await m.download(e.id);
      toast.success(t('ai.models.ready', { name: e.name }));
    } catch (err) {
      toast.error(t('ai.models.failed', { name: e.name, message: errText(err) }));
    }
  };

  const acceptAndDownload = async (e: ModelEntry) => {
    setLicence(null);
    await m.acceptLicence(e.id);
    await download(e);
  };

  const buildIndex = async () => {
    if (!database || !ctx || !s) return;
    setIndexing({ done: 0, total: 0 });
    try {
      const n = await indexHsnMaster(database, ctx, embedderFor(s), {
        onProgress: (done, total) => setIndexing({ done, total }),
      });
      resetHybridHsn();
      toast.success(t('ai.hsn.indexed', { count: n }));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setIndexing(null);
    }
  };

  if (!s) return null;
  const cls: DeviceClass | null = hw ? deviceClassOf(hw) : null;
  const platform = hw ? platformOf(hw) : '';
  const recommended =
    manifest?.ok && hw && cls
      ? bundleFor(manifest.manifest, cls, { ramGb: hw.ramGb, platform })
      : [];
  const entries = m
    .entries()
    .filter((e) => e.platforms.length === 0 || e.platforms.includes(platform));
  const anyReady = m.ready().length > 0;
  const readyOf = (kind: ModelKind) => m.ready(kind);
  const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  void states;

  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="ai-tab">
      <Card>
        <h2 className="font-medium">{t('ai.backend.title')}</h2>
        <p className="text-sm text-fg-muted">{t('ai.backend.intro')}</p>
        <RadioGroup
          value={s.tier1}
          onValueChange={(v) => void save({ tier1: v as Tier1Choice })}
          className="flex flex-col gap-2 py-3"
          aria-label={t('ai.backend.title')}
        >
          {(['off', 'builtin', 'ollama', 'webllm'] as const).map((choice) => {
            const disabled =
              (choice === 'builtin' && !isDesktop()) || (choice === 'webllm' && !webgpu);
            return (
              <label
                key={choice}
                htmlFor={`ai-tier1-${choice}`}
                className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-50' : ''}`}
              >
                <RadioGroupItem
                  id={`ai-tier1-${choice}`}
                  value={choice}
                  disabled={disabled}
                  data-testid={`ai-tier1-${choice}`}
                />
                <span>
                  <span className="font-medium">{t(`ai.backend.${choice}.label` as never)}</span>
                  <span className="block text-fg-muted">
                    {t(`ai.backend.${choice}.help` as never)}
                  </span>
                </span>
              </label>
            );
          })}
        </RadioGroup>
        {s.tier1 === 'ollama' && (
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col">
              {t('ai.backend.ollama.url')}
              <Input
                className="w-64"
                value={s.ollamaUrl}
                onChange={(e) => void save({ ollamaUrl: e.target.value })}
              />
            </label>
            <label className="flex flex-col">
              {t('ai.backend.ollama.model')}
              <Input
                className="w-48"
                value={s.ollamaModel}
                list="ollama-models"
                onChange={(e) => void save({ ollamaModel: e.target.value })}
              />
              <datalist id="ollama-models">
                {(ollama ?? []).map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </label>
            <Button
              variant="secondary"
              onClick={async () => {
                const { OllamaProvider } = await import('@gst/ai');
                try {
                  const names = await new OllamaProvider({
                    baseUrl: s.ollamaUrl,
                    model: s.ollamaModel,
                  }).models();
                  setOllama(names);
                  toast.success(t('ai.backend.ollama.found', { count: names.length }));
                } catch (e) {
                  toast.error(t('ai.backend.ollama.unreachable', { message: errText(e) }));
                }
              }}
            >
              {t('ai.backend.ollama.check')}
            </Button>
          </div>
        )}
        <p className="pt-2 text-xs text-fg-muted">{t('ai.backend.privacy')}</p>
      </Card>

      <Card data-testid="ai-models">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">{t('ai.models.title')}</h2>
          {hw && cls && (
            <span className="text-xs text-fg-muted" data-testid="ai-hardware">
              {t('ai.models.hardware', {
                ram: hw.ramGb,
                cores: hw.cores,
                gpu: t(`ai.models.gpu.${hw.gpu}` as never),
                cls: t(`ai.models.class.${cls}` as never),
              })}
            </span>
          )}
        </div>
        {!anyReady && (
          <p className="py-2 text-sm" data-testid="ai-enable-cta">
            {t('ai.models.none')}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2 py-2 text-sm">
          <label className="flex flex-col">
            {t('ai.models.manifest')}
            <Input
              className="w-80"
              value={manifestUrl ?? s.manifestUrl}
              placeholder={t('ai.models.manifestDefault')}
              onChange={(e) => setManifestUrl(e.target.value)}
            />
          </label>
          <Button
            variant="secondary"
            onClick={async () => {
              const url = manifestUrl ?? s.manifestUrl;
              await save({ manifestUrl: url });
              const r = await loadManifest(url);
              setManifest(r);
              if (!r.ok) toast.error(t(`ai.models.manifestError.${r.reason}` as never));
            }}
          >
            {t('ai.models.reload')}
          </Button>
          {manifest && !manifest.ok && (
            <span role="alert" className="text-danger">
              {t(`ai.models.manifestError.${manifest.reason}` as never)}
            </span>
          )}
        </div>
        {recommended.length > 0 && (
          <p className="py-1 text-sm">
            {t('ai.models.recommended', { names: recommended.map((e) => e.name).join(', ') })}
          </p>
        )}
        <ul className="divide-y divide-border" data-testid="ai-model-list">
          {entries.map((e) => {
            const st = m.get(e.id);
            const pct = st && st.totalBytes ? Math.round((st.bytes / st.totalBytes) * 100) : 0;
            const tooBig = hw ? !fits(hw, e.sizeBytes) && e.kind === 'llm' : false;
            return (
              <li
                key={e.id}
                className="flex flex-wrap items-center gap-3 py-2 text-sm"
                data-testid="ai-model"
                data-model={e.id}
                data-status={st?.status ?? 'none'}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.name}</span>
                    <Badge tone="neutral">{t(`ai.models.kind.${e.kind}` as never)}</Badge>
                    <span className="text-fg-muted">{size(e.sizeBytes)}</span>
                    <span className="text-fg-muted">{e.licence.name}</span>
                    {recommended.some((r) => r.id === e.id) && (
                      <Badge tone="info">{t('ai.models.recommendedBadge')}</Badge>
                    )}
                    {tooBig && <Badge tone="warning">{t('ai.models.tooBig')}</Badge>}
                  </div>
                  {e.notes && <p className="text-xs text-fg-muted">{e.notes}</p>}
                  {st?.status === 'downloading' ||
                  st?.status === 'paused' ||
                  st?.status === 'verifying' ? (
                    <div
                      className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded bg-surface-3"
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  ) : null}
                  {st?.status === 'error' && <p className="text-xs text-danger">{st.error}</p>}
                </div>
                <div className="flex gap-1">
                  {(!st || st.status === 'none' || st.status === 'error') && (
                    <Button
                      variant="secondary"
                      data-testid="ai-model-download"
                      onClick={() => void download(e)}
                    >
                      {st?.licenceAcceptedAt
                        ? t('ai.models.download')
                        : t('ai.models.licenceAndDownload')}
                    </Button>
                  )}
                  {st?.status === 'downloading' && (
                    <Button variant="ghost" onClick={() => m.pause(e.id)}>
                      {t('ai.models.pause')}
                    </Button>
                  )}
                  {st?.status === 'paused' && (
                    <Button variant="secondary" onClick={() => void download(e)}>
                      {t('ai.models.resume')}
                    </Button>
                  )}
                  {st && st.status !== 'none' && st.status !== 'downloading' && (
                    <Button variant="ghost" onClick={() => void m.delete(e.id)}>
                      {t('ai.models.delete')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {entries.length === 0 && manifest?.ok && (
          <p className="text-sm text-fg-muted">{t('ai.models.empty')}</p>
        )}
        <DiskUse />
        <div className="grid gap-2 pt-3 text-sm md:grid-cols-2">
          {(
            [
              ['llmModelId', 'llm'],
              ['embedModelId', 'embedding'],
              ['whisperModelId', 'whisper'],
              ['ocrModelId', 'ocr'],
            ] as const
          ).map(([key, kind]) => (
            <label key={key} className="flex flex-col">
              {t(`ai.models.use.${kind}` as never)}
              <Select
                value={s[key] ?? '__none'}
                onValueChange={(v) => void save({ [key]: v === '__none' ? null : v })}
              >
                <SelectTrigger data-testid={`ai-use-${kind}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">{t('ai.models.useNone')}</SelectItem>
                  {readyOf(kind).map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ))}
        </div>
      </Card>

      <Card>
        <h2 className="font-medium">{t('ai.hsn.title')}</h2>
        <p className="text-sm text-fg-muted">{t('ai.hsn.intro')}</p>
        <div className="flex items-center gap-3 pt-2">
          <Button
            variant="secondary"
            data-testid="ai-hsn-index"
            disabled={!!indexing}
            onClick={() => void buildIndex()}
          >
            {indexing
              ? t('ai.hsn.indexing', { done: indexing.done, total: indexing.total })
              : t('ai.hsn.build')}
          </Button>
        </div>
      </Card>

      {isDesktop() && (
        <Card>
          <h2 className="font-medium">{t('ai.watch.title')}</h2>
          <p className="text-sm text-fg-muted">{t('ai.watch.intro')}</p>
          <div className="flex flex-wrap items-end gap-2 pt-2 text-sm">
            <label className="flex flex-col">
              {t('ai.watch.folder')}
              <Input
                className="w-96"
                value={s.watchFolder ?? ''}
                placeholder={t('ai.watch.placeholder')}
                onChange={(e) => void save({ watchFolder: e.target.value.trim() || null })}
              />
            </label>
          </div>
        </Card>
      )}

      {licence && (
        <LicenceDialog
          entry={licence}
          onCancel={() => setLicence(null)}
          onAccept={() => void acceptAndDownload(licence)}
        />
      )}
    </div>
  );
}

function DiskUse() {
  const { t } = useTranslation();
  const states = useModelStates();
  const [bytes, setBytes] = useState<number | null>(null);
  useEffect(() => {
    void modelManager().diskUsage().then(setBytes);
  }, [states]);
  return (
    <p className="pt-2 text-xs text-fg-muted" data-testid="ai-disk">
      {t('ai.models.disk', { size: bytes === null ? '…' : size(bytes) })}
    </p>
  );
}

function LicenceDialog({
  entry,
  onCancel,
  onAccept,
}: {
  entry: ModelEntry;
  onCancel: () => void;
  onAccept: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent data-testid="ai-licence">
        <AlertDialogTitle>{t('ai.models.licenceTitle', { name: entry.name })}</AlertDialogTitle>
        <AlertDialogDescription>
          {t('ai.models.licenceIntro', {
            licence: entry.licence.name,
            size: size(entry.sizeBytes),
          })}
        </AlertDialogDescription>
        <p className="whitespace-pre-wrap rounded bg-surface-2 p-2 text-sm">
          {entry.licence.summary}
        </p>
        {entry.licence.url && (
          <a
            className="text-sm underline"
            href={entry.licence.url}
            target="_blank"
            rel="noreferrer"
          >
            {t('ai.models.licenceRead')}
          </a>
        )}
        <div className="flex justify-end gap-2 pt-3">
          <Button variant="ghost" onClick={onCancel}>
            {t('confirm.cancel')}
          </Button>
          <Button data-testid="ai-licence-accept" onClick={onAccept}>
            {t('ai.models.licenceAccept')}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

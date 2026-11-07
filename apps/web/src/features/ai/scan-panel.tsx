/**
 * "Scan a bill": choose or drop a photo or PDF (the camera on a phone), watch the steps, and find the
 * result in the inbox. Without an OCR engine the panel says how to enable offline AI instead of failing.
 */
import { Button, Card, toast } from '@gst/ui';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { chooseOcrEngine } from './ocr';
import { useAiRouter } from './router';
import { scanFile, ScanError, type ScanStep } from './scan';
import { useAiSettings } from './settings';

import { DEMO_REQUESTED, useAppDb } from '@/app/db';
import { useAppNavigate, useLocationInfo } from '@/app/hooks';
import { useAppStore } from '@/app/store';
import { track } from '@/features/telemetry/telemetry';

const STEPS: ScanStep[] = [
  'read',
  'store',
  'prepare',
  'ocr',
  'rules',
  'model',
  'match',
  'check',
  'inbox',
];

export function ScanPanel({ onScanned }: { onScanned?: (reviewItemId: string) => void }) {
  const { t } = useTranslation();
  const { database, ctx, business } = useAppDb();
  const { search } = useLocationInfo();
  const shell = useAppStore((s) => s.shell);
  const navigate = useAppNavigate();
  const settings = useAiSettings();
  const built = useAiRouter(database, ctx, business);
  const [step, setStep] = useState<ScanStep | null>(null);
  const [queue, setQueue] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // the demo flag is read once at start; the address loses it after the seed
  const demo = DEMO_REQUESTED || search['demo'] === '1';
  const ocr = settings.data ? chooseOcrEngine(settings.data, demo) : null;
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;

  const run = async (files: File[]) => {
    if (!database || !ctx || !business || !settings.data || !ocr) return;
    if (!ocr.engine) {
      setError(t('ai.scan.noOcr'));
      return;
    }
    setError(null);
    setQueue({ done: 0, total: files.length });
    let last: string | null = null;
    for (const f of files) {
      try {
        const out = await scanFile(
          { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) },
          {
            db: database,
            ctx,
            business,
            ocr: ocr.engine,
            router: built?.router ?? null,
            languages: settings.data.ocrLanguages,
            onStep: setStep,
          },
        );
        last = out.reviewItemId;
        track('ai_scan');
      } catch (e) {
        const code = e instanceof ScanError ? e.code : 'failed';
        setError(
          t(`ai.scan.errors.${code}` as never, {
            name: f.name,
            message: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        setQueue((q) => ({ ...q, done: q.done + 1 }));
      }
    }
    setStep(null);
    if (last) {
      toast.success(t('ai.scan.done', { count: files.length }));
      onScanned?.(last);
    }
  };

  return (
    <Card className="mb-3" data-testid="scan-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">{t('ai.scan.title')}</h2>
          <p className="text-sm text-fg-muted">{t('ai.scan.intro')}</p>
        </div>
        <div className="flex gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            multiple
            hidden
            data-testid="scan-input"
            {...(touch ? { capture: 'environment' as const } : {})}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) void run(files);
            }}
          />
          <Button
            data-testid="scan-pick"
            disabled={step !== null}
            onClick={() => input.current?.click()}
          >
            {touch ? t('ai.scan.camera') : t('ai.scan.choose')}
          </Button>
        </div>
      </div>
      <div
        className="mt-3 rounded border border-dashed border-border p-3 text-center text-sm text-fg-muted"
        data-testid="scan-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const files = [...e.dataTransfer.files];
          if (files.length) void run(files);
        }}
      >
        {step ? (
          <ol
            className="flex flex-wrap justify-center gap-2"
            aria-live="polite"
            data-testid="scan-steps"
          >
            {STEPS.map((s) => (
              <li
                key={s}
                className={
                  s === step
                    ? 'font-medium text-fg'
                    : STEPS.indexOf(s) < STEPS.indexOf(step)
                      ? 'text-success-fg'
                      : ''
                }
                data-step={s}
              >
                {t(`ai.scan.steps.${s}` as never)}
              </li>
            ))}
            {queue.total > 1 && (
              <li className="tabular-nums">{`${queue.done + 1}/${queue.total}`}</li>
            )}
          </ol>
        ) : (
          t('ai.scan.drop')
        )}
      </div>
      {ocr && !ocr.engine && (
        <p
          className="mt-2 flex flex-wrap items-center gap-2 text-sm text-warning-fg"
          data-testid="scan-no-ocr"
        >
          {t('ai.scan.noOcr')}
          <Button variant="secondary" onClick={() => navigate(`/${shell}/settings`, { tab: 'ai' })}>
            {t('ai.enable')}
          </Button>
        </p>
      )}
      {ocr?.why === 'demo' && <p className="mt-2 text-xs text-fg-muted">{t('ai.scan.demoNote')}</p>}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger" data-testid="scan-error">
          {error}
        </p>
      )}
    </Card>
  );
}

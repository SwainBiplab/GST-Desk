import { ImportCancelled, ImportMappingRepo } from '@gst/db';
import {
  CsvError,
  detectMapping,
  missingRequired,
  parseCsv,
  toCsv,
  toSavedMapping,
  type Mapping,
} from '@gst/domain';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@gst/ui';
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { ImportReview, ImportSpec } from './types';

import { useAppDb } from '@/app/db';
import { downloadText } from '@/features/parties/csv';

type Step = 'upload' | 'map' | 'review' | 'run' | 'done';

const MAX_BYTES = 25 * 1024 * 1024;
const NONE = '-';
const SHOWN_PROBLEMS = 100;

/** Read a file as UTF-8, or as Windows-1252 when it is not valid UTF-8 (Excel's "CSV" on Windows). */
async function readText(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

interface Loaded {
  fileName: string;
  headers: string[];
  rows: string[][];
  lines: number[];
}

/**
 * Import a CSV of items or parties: choose the file, check the column mapping, review what is wrong
 * line by line (a dry run: nothing is written), then import in one transaction with progress and
 * cancel. Nothing is stored unless every selected row is stored.
 */
export function ImportWizard({ spec, onClose }: { spec: ImportSpec; onClose: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [step, setStep] = useState<Step>('upload');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [remember, setRemember] = useState(true);
  const [review, setReview] = useState<ImportReview | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<{ imported: number; seconds: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancel = useRef(false);

  const label = (key: string) => t(`import.fields.${key}`);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !database || !ctx) return;
    setError(null);
    if (file.size > MAX_BYTES) return setError(t('import.tooBig'));
    setBusy(true);
    try {
      const parsed = parseCsv(await readText(file));
      const [head, ...rows] = parsed.rows;
      if (!head || rows.length === 0) return setError(t('import.empty'));
      const headers = head.map((h) => h.trim());
      const saved = await new ImportMappingRepo(database).forHeaders(ctx, spec.entity, headers);
      setLoaded({ fileName: file.name, headers, rows, lines: parsed.lines.slice(1) });
      setMapping(detectMapping(headers, spec.fields, saved));
      setStep('map');
    } catch (err) {
      setError(
        err instanceof CsvError
          ? t('import.csvError', { line: err.line })
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const missing = missingRequired(mapping, spec.fields);

  const toReview = async () => {
    if (!loaded || !database || !ctx) return;
    setBusy(true);
    setError(null);
    try {
      if (remember) {
        await new ImportMappingRepo(database).save(
          ctx,
          spec.entity,
          loaded.headers,
          toSavedMapping(loaded.headers, mapping),
        );
      }
      setReview(
        await spec.review({
          headers: loaded.headers,
          rows: loaded.rows,
          lines: loaded.lines,
          mapping,
          database,
          ctx,
        }),
      );
      setSkipInvalid(false);
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!review || !database || !ctx) return;
    cancel.current = false;
    setError(null);
    setProgress({ done: 0, total: review.valid.length });
    setStep('run');
    const t0 = performance.now();
    try {
      const imported = await spec.commit({
        values: review.valid.map((v) => v.values),
        database,
        ctx,
        onProgress: (done, total) => setProgress({ done, total }),
        shouldCancel: () => cancel.current,
      });
      setResult({ imported, seconds: (performance.now() - t0) / 1000 });
      setStep('done');
    } catch (err) {
      if (err instanceof ImportCancelled) toast.info(t('import.cancelled'));
      else setError(err instanceof Error ? err.message : String(err));
      setStep('review');
    }
  };

  const problemText = (r: ImportReview['invalid'][number]) =>
    r.problems.map((p) => `${label(p.field)}: ${t(`val.${p.code}`)}`).join('; ');

  const downloadProblems = () => {
    if (!review || !loaded) return;
    downloadText(
      `${spec.entity}-import-problems.csv`,
      toCsv([
        ['Line', 'Problems', ...loaded.headers],
        ...review.invalid.map((r) => [String(r.line), problemText(r), ...r.raw]),
      ]),
    );
  };

  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const toImport = review ? review.valid.length : 0;
  const invalid = review ? review.invalid.length : 0;
  const canImport = toImport > 0 && (invalid === 0 || skipInvalid);

  return (
    <Dialog open onOpenChange={(o) => !o && step !== 'run' && onClose()}>
      <DialogContent
        className="flex max-h-[90vh] w-[min(56rem,calc(100vw-2rem))] flex-col gap-3 overflow-hidden"
        data-testid="import-wizard"
        onInteractOutside={(e) => step === 'run' && e.preventDefault()}
        onEscapeKeyDown={(e) => step === 'run' && e.preventDefault()}
      >
        <DialogTitle className="text-lg font-semibold">
          {t(`import.title.${spec.entity}`)}
        </DialogTitle>
        <DialogDescription className="text-fg-muted">{t(`import.step.${step}`)}</DialogDescription>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-danger p-2 text-sm text-danger"
            data-testid="import-error"
          >
            {error}
          </p>
        )}

        {step === 'upload' && (
          <div className="flex flex-col gap-3">
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              data-testid="import-file"
              aria-label={t('import.chooseFile')}
              disabled={busy}
              onChange={(e) => void onFile(e)}
              className="text-sm"
            />
            <p className="text-sm text-fg-muted">{t('import.fileHelp')}</p>
            <div>
              <Button
                variant="outline"
                data-testid="import-template"
                onClick={() => downloadText(spec.templateName, spec.template)}
              >
                {t('import.template')}
              </Button>
            </div>
          </div>
        )}

        {step === 'map' && loaded && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <p className="text-sm">
              {t('import.mapHelp', { file: loaded.fileName, rows: loaded.rows.length })}
            </p>
            <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-2 text-left text-xs text-fg-muted">
                  <tr>
                    <th className="p-2">{t('import.field')}</th>
                    <th className="p-2">{t('import.column')}</th>
                    <th className="p-2">{t('import.sample')}</th>
                  </tr>
                </thead>
                <tbody>
                  {spec.fields.map((f) => {
                    const col = mapping[f.key] ?? null;
                    return (
                      <tr key={f.key} className="border-t border-border">
                        <td className="p-2">
                          {label(f.key)}
                          {f.required && <span aria-hidden> *</span>}
                        </td>
                        <td className="p-2">
                          <Select
                            value={col === null ? NONE : String(col)}
                            onValueChange={(v) =>
                              setMapping((m) => ({ ...m, [f.key]: v === NONE ? null : Number(v) }))
                            }
                          >
                            <SelectTrigger
                              className="w-56"
                              aria-label={label(f.key)}
                              data-testid={`import-map-${f.key}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE}>{t('import.notImported')}</SelectItem>
                              {loaded.headers.map((h, i) => (
                                <SelectItem key={i} value={String(i)}>
                                  {h || `#${i + 1}`}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="max-w-64 truncate p-2 text-fg-muted">
                          {col === null
                            ? ''
                            : loaded.rows
                                .slice(0, 3)
                                .map((r) => r[col] ?? '')
                                .join(' | ')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <label className="flex items-center gap-2 text-sm" htmlFor="import-remember">
              <Checkbox
                id="import-remember"
                checked={remember}
                onCheckedChange={(v) => setRemember(v === true)}
              />
              {t('import.remember')}
            </label>
            {missing.length > 0 && (
              <p role="alert" className="text-sm text-danger">
                {t('import.missing', { fields: missing.map(label).join(', ') })}
              </p>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep('upload')}>
                {t('import.back')}
              </Button>
              <Button
                data-testid="import-continue"
                disabled={missing.length > 0 || busy}
                onClick={() => void toReview()}
              >
                {busy ? t('import.checking') : t('import.check')}
              </Button>
            </div>
          </div>
        )}

        {step === 'review' && review && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <p className="text-sm font-medium" data-testid="import-review-summary">
              {t('import.summary', { ready: toImport, total: review.total, problems: invalid })}
            </p>
            <p className="text-xs text-fg-muted">{t('import.dryRun')}</p>
            {invalid > 0 && (
              <>
                <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
                  <table className="w-full text-sm" aria-label={t('import.problems')}>
                    <thead className="sticky top-0 bg-surface-2 text-left text-xs text-fg-muted">
                      <tr>
                        <th className="p-2">{t('import.line')}</th>
                        <th className="p-2">{t('import.problem')}</th>
                        <th className="p-2">{t('import.row')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {review.invalid.slice(0, SHOWN_PROBLEMS).map((r) => (
                        <tr
                          key={r.line}
                          className="border-t border-border"
                          data-testid="import-problem-row"
                        >
                          <td className="p-2 tabular-nums">{r.line}</td>
                          <td className="p-2 text-danger">{problemText(r)}</td>
                          <td className="max-w-64 truncate p-2 text-fg-muted">
                            {r.raw.join(' | ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {invalid > SHOWN_PROBLEMS && (
                  <p className="text-xs text-fg-muted">
                    {t('import.moreProblems', { count: invalid - SHOWN_PROBLEMS })}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-4">
                  <Button
                    variant="outline"
                    data-testid="import-download-problems"
                    onClick={downloadProblems}
                  >
                    {t('import.downloadProblems')}
                  </Button>
                  <label className="flex items-center gap-2 text-sm" htmlFor="import-skip">
                    <Checkbox
                      id="import-skip"
                      data-testid="import-skip-invalid"
                      checked={skipInvalid}
                      onCheckedChange={(v) => setSkipInvalid(v === true)}
                    />
                    {t('import.skipInvalid', { count: invalid })}
                  </label>
                </div>
              </>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep('map')}>
                {t('import.back')}
              </Button>
              <Button data-testid="import-start" disabled={!canImport} onClick={() => void start()}>
                {t('import.start', { count: toImport })}
              </Button>
            </div>
          </div>
        )}

        {step === 'run' && (
          <div className="flex flex-col gap-3" data-testid="import-running">
            <div
              role="progressbar"
              aria-label={t('import.progress')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              data-testid="import-progress"
              className="h-3 w-full overflow-hidden rounded-full bg-surface-2"
            >
              <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-sm tabular-nums" aria-live="polite">
              {t('import.progressText', { done: progress.done, total: progress.total })}
            </p>
            <p className="text-xs text-fg-muted">{t('import.cancelHelp')}</p>
            <div>
              <Button
                variant="outline"
                data-testid="import-cancel"
                onClick={() => (cancel.current = true)}
              >
                {t('import.cancel')}
              </Button>
            </div>
          </div>
        )}

        {step === 'done' && result && review && (
          <div className="flex flex-col gap-3" data-testid="import-done">
            <p className="text-sm font-medium">
              {t('import.done', { count: result.imported, seconds: result.seconds.toFixed(1) })}
            </p>
            {invalid > 0 && (
              <p className="text-sm text-fg-muted">{t('import.skipped', { count: invalid })}</p>
            )}
            <div className="flex gap-2">
              {invalid > 0 && (
                <Button variant="outline" onClick={downloadProblems}>
                  {t('import.downloadProblems')}
                </Button>
              )}
              <Button data-testid="import-close" onClick={onClose}>
                {t('import.close')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

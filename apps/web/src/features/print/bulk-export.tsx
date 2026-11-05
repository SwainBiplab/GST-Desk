import { SettingsRepo, TemplateRepo } from '@gst/db';
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '@gst/ui';
import { zipSync } from 'fflate';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { downloadBytes, patternName } from './actions';
import { familiesFor, loadFonts } from './fonts-client';
import { loadPrintContext, modelForDocument } from './model';
import { cancelPdfWork, makePdf } from './pdf-client';
import { specOf, useTemplates, withPartyLanguage } from './use-templates';

import { useAppDb } from '@/app/db';

export const BULK_PATTERN_KEY = 'print.bulk_pattern';
export const DEFAULT_BULK_PATTERN = '{type}-{number}';

type State =
  | { kind: 'running'; done: number; total: number; name: string }
  | { kind: 'done'; total: number; file: string }
  | { kind: 'cancelled'; done: number }
  | { kind: 'failed'; message: string };

/**
 * Make the PDF of every chosen document, one after another in the PDF worker, and download them as one
 * ZIP. Shows progress and can be cancelled; a document that cannot be made stops the export and says which.
 */
export function BulkExportDialog({
  ids,
  onClose,
}: {
  ids: readonly string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx, business } = useAppDb();
  const { options } = useTemplates();
  const [state, setState] = useState<State>({
    kind: 'running',
    done: 0,
    total: ids.length,
    name: '',
  });
  const cancelled = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !database || !ctx || options.length === 0) return;
    started.current = true;
    void (async () => {
      try {
        const pc = await loadPrintContext(database, ctx);
        const pattern =
          (await new SettingsRepo(database).getValue<string>(ctx, BULK_PATTERN_KEY)) ||
          DEFAULT_BULK_PATTERN;
        const fyStart = Number(business?.['fy_start_month'] ?? 4);
        const templates = new TemplateRepo(database);
        const files: Record<string, Uint8Array> = {};
        for (const [i, id] of ids.entries()) {
          if (cancelled.current) return;
          const found = await modelForDocument(database, ctx, pc, id);
          if (!found) continue;
          const { model } = found;
          const spec = withPartyLanguage(
            specOf(options, await templates.resolveId(ctx, model.type, 'books')),
            model.party,
          );
          let name = patternName(pattern, model, fyStart);
          for (let n = 2; files[name]; n++) name = name.replace(/(-\d+)?\.pdf$/, `-${n}.pdf`);
          setState({ kind: 'running', done: i, total: ids.length, name });
          const fonts = await loadFonts(familiesFor(model, spec));
          files[name] = await makePdf(model, spec, fonts.bytes, {
            title: name,
            author: model.business.name,
            created: new Date(`${model.date}T00:00:00Z`),
          });
        }
        if (cancelled.current) return;
        // PDFs are already compressed: store them in the ZIP
        const zip = zipSync(files, { level: 0 });
        const file = `${pc.business.name.replace(/\W+/g, '-')}-documents-${new Date().toISOString().slice(0, 10)}.zip`;
        downloadBytes(file, zip, 'application/zip');
        setState({ kind: 'done', total: Object.keys(files).length, file });
      } catch (e) {
        if (cancelled.current) return;
        setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, [database, ctx, options, ids, business]);

  const stop = () => {
    cancelled.current = true;
    cancelPdfWork();
    setState((s) => ({ kind: 'cancelled', done: s.kind === 'running' ? s.done : 0 }));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && (state.kind === 'running' ? stop() : onClose())}>
      <DialogContent data-testid="bulk-export" onInteractOutside={(e) => e.preventDefault()}>
        <DialogTitle className="text-lg font-semibold">{t('print.bulk.title')}</DialogTitle>
        <DialogDescription className="text-sm text-fg-muted">
          {t('print.bulk.help', { count: ids.length })}
        </DialogDescription>
        {state.kind === 'running' && (
          <div className="flex flex-col gap-2" data-testid="bulk-progress">
            <progress className="w-full" max={state.total} value={state.done} />
            <p className="text-sm" aria-live="polite" data-testid="bulk-status">
              {t('print.bulk.progress', { done: state.done, total: state.total })}
              {state.name ? ` · ${state.name}` : ''}
            </p>
          </div>
        )}
        {state.kind === 'done' && (
          <p className="text-sm" role="status" data-testid="bulk-done">
            {t('print.bulk.done', { count: state.total, file: state.file })}
          </p>
        )}
        {state.kind === 'cancelled' && (
          <p className="text-sm" role="status" data-testid="bulk-cancelled">
            {t('print.bulk.cancelled', { done: state.done })}
          </p>
        )}
        {state.kind === 'failed' && (
          <p className="text-sm text-danger" role="alert" data-testid="bulk-failed">
            {state.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          {state.kind === 'running' ? (
            <Button variant="outline" data-testid="bulk-cancel" onClick={stop}>
              {t('print.bulk.cancel')}
            </Button>
          ) : (
            <Button data-testid="bulk-close" onClick={onClose}>
              {t('print.bulk.close')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

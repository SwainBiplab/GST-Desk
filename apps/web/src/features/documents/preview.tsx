import {
  layoutDocument,
  receiptLines,
  receiptText,
  thermalColumns,
  type PrintModel,
  type TemplateSpec,
} from '@gst/print';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@gst/ui';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { familiesFor, usePrintFonts } from '../print/fonts-client';
import { PageView } from '../print/page-view';
import type { TemplateOption } from '../print/use-templates';

export type PaperSize = 'page' | 'thermal';

/**
 * The document as it will print, drawn from the same layout the PDF uses, so what you see is what you
 * get. It follows the form 150 ms after the last change (the model arrives already debounced). Choose
 * a template, the full page or the receipt roll, and zoom.
 */
export function DocumentPreview({
  model,
  spec,
  templates,
  templateId,
  onTemplate,
}: {
  model: PrintModel | null;
  spec: TemplateSpec;
  templates: readonly TemplateOption[];
  templateId: string;
  onTemplate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [paper, setPaper] = useState<PaperSize>('page');
  const [zoom, setZoom] = useState(70);
  // drawn at a lower priority than typing: a keystroke is never held up by a redraw of the page
  const shownModel = useDeferredValue(model);
  const fonts = usePrintFonts(shownModel ? familiesFor(shownModel, spec) : ['latin', 'latinExt']);

  const pages = useMemo(
    () =>
      shownModel && fonts && paper === 'page'
        ? layoutDocument(shownModel, spec, { measurer: fonts.measurer }).pages
        : null,
    [shownModel, fonts, spec, paper],
  );
  const receipt = useMemo(
    () =>
      shownModel && paper === 'thermal'
        ? receiptText(receiptLines(shownModel, spec), thermalColumns(spec.thermal.widthMm))
        : null,
    [shownModel, spec, paper],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="doc-preview">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={templateId} onValueChange={onTemplate}>
          <SelectTrigger
            className="w-44"
            aria-label={t('print.template')}
            data-testid="preview-template"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {templates.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={paper} onValueChange={(v) => setPaper(v as PaperSize)}>
          <SelectTrigger
            className="w-32"
            aria-label={t('docs.preview.paper')}
            data-testid="preview-paper"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="page">{spec.page.size.toUpperCase()}</SelectItem>
            <SelectItem value="thermal">{t('docs.preview.thermal')}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          aria-label={t('docs.preview.zoomOut')}
          onClick={() => setZoom((z) => Math.max(30, z - 10))}
        >
          −
        </Button>
        <span className="w-12 text-center text-sm tabular" data-testid="preview-zoom">
          {zoom}%
        </span>
        <Button
          variant="outline"
          aria-label={t('docs.preview.zoomIn')}
          onClick={() => setZoom((z) => Math.min(150, z + 10))}
        >
          +
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-surface-2 p-2">
        {receipt !== null ? (
          <pre
            id="print-area"
            data-testid="preview-sheet"
            data-paper="thermal"
            className="origin-top-left bg-white p-3 font-mono text-[11px] leading-tight text-black shadow-sm"
            style={{ width: `${spec.thermal.widthMm}mm`, transform: `scale(${zoom / 70})` }}
          >
            {receipt}
          </pre>
        ) : pages && fonts ? (
          <PageView pages={pages} zoom={zoom} measurer={fonts.measurer} paper={spec.page.size} />
        ) : (
          <p className="p-4 text-sm text-fg-muted" data-testid="preview-loading">
            {t('empty.loading')}
          </p>
        )}
      </div>
    </div>
  );
}

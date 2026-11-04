import type { Row } from '@gst/db';
import {
  amountToWordsEn,
  declarationFor,
  divRound,
  sanitiseRichText,
  STATES,
  toDecimalString,
  type BuiltDocument,
  type DraftDocument,
} from '@gst/domain';
import {
  Button,
  MoneyText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@gst/ui';
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { qtyText, rateText } from './state';

const PREVIEW_DELAY_MS = 150;

/** A value that follows `value` after it has been still for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

export type PaperSize = 'a4' | 'thermal';

const addressLine = (a: unknown): string => {
  if (!a || typeof a !== 'object') return '';
  const x = a as Record<string, string>;
  return [x['line1'], x['line2'], x['city'], x['pincode']].filter(Boolean).join(', ');
};

/**
 * The document as it will print, from the same engine numbers as the grid. A plain layout until the
 * template designer (prompt 17); updates 150 ms after the last change. A4 or a narrow receipt, zoomable.
 */
export function DocumentPreview({
  draft,
  built,
  business,
  units,
  number,
  status = 'draft',
}: {
  draft: DraftDocument;
  built: BuiltDocument;
  business: Row | null;
  units: ReadonlyMap<string, string>;
  number: string | null;
  status?: string;
}) {
  const { t } = useTranslation();
  const [paper, setPaper] = useState<PaperSize>('a4');
  const [zoom, setZoom] = useState(70);
  const shown = useDebounced({ draft, built }, PREVIEW_DELAY_MS);
  const d = shown.draft;
  const b = shown.built;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="doc-preview">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={paper} onValueChange={(v) => setPaper(v as PaperSize)}>
          <SelectTrigger
            className="w-32"
            aria-label={t('docs.preview.paper')}
            data-testid="preview-paper"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a4">A4</SelectItem>
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
        <div style={{ width: (paper === 'a4' ? 794 : 302) * (zoom / 100) }}>
          <PreviewSheet
            draft={d}
            built={b}
            paper={paper}
            zoom={zoom}
            business={business}
            units={units}
            number={number}
            status={status}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The printable sheet. It only redraws when its own data changes, so typing in a form field does not
 * redraw a table of hundreds of lines.
 */
const PreviewSheet = memo(function PreviewSheet({
  draft: d,
  built: b,
  paper,
  zoom,
  business,
  units,
  number,
  status,
}: {
  draft: DraftDocument;
  built: BuiltDocument;
  paper: PaperSize;
  zoom: number;
  business: Row | null;
  units: ReadonlyMap<string, string>;
  number: string | null;
  status: string;
}) {
  const { t } = useTranslation();
  const scheme = business?.['scheme'] === 'composition' ? 'composition' : 'regular';
  const declaration = declarationFor(d.type, scheme);
  const width = paper === 'a4' ? 794 : 302;
  const foreign = d.currency !== 'INR' && d.fxRateMicros > 0n;
  const inForeign = foreign ? divRound(b.totals.totalPaise * 1_000_000n, d.fxRateMicros) : 0n;

  const notes = useMemo(() => sanitiseRichText(d.notes), [d.notes]);
  const terms = useMemo(() => sanitiseRichText(d.terms), [d.terms]);
  const heads = [
    ['CGST', b.totals.cgstPaise],
    ['SGST', b.totals.sgstPaise],
    ['UTGST', b.totals.utgstPaise],
    ['IGST', b.totals.igstPaise],
    ['Cess', b.totals.cessPaise],
  ] as const;

  return (
    <article
      id="print-area"
      data-testid="preview-sheet"
      data-paper={paper}
      className="relative origin-top-left bg-white p-6 text-[12px] leading-snug text-black shadow-sm"
      style={{ width, transform: `scale(${zoom / 100})` }}
    >
      {status === 'cancelled' && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          data-testid="preview-cancelled"
        >
          <span className="-rotate-[20deg] rounded border-4 border-red-600/50 px-4 py-1 text-5xl font-bold text-red-600/50">
            {t('docs.cancel.stamp')}
          </span>
        </div>
      )}
      <header className="flex justify-between gap-4 border-b border-black pb-2">
        <div>
          <h2 className="text-base font-bold" data-testid="preview-business">
            {business?.['trade_name'] ?? business?.['legal_name'] ?? ''}
          </h2>
          <p>{addressLine(business?.['address'])}</p>
          {business?.['gstin'] && <p>GSTIN: {business['gstin']}</p>}
        </div>
        <div className="text-right">
          <h3 className="text-sm font-bold uppercase" data-testid="preview-title">
            {t(`docs.types.${d.type}`)}
          </h3>
          <p data-testid="preview-number">{number ?? t('docs.preview.draft')}</p>
          <p>{d.date}</p>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 py-2">
        <div>
          <p className="font-semibold">
            {t(d.type.startsWith('purchase') ? 'docs.header.supplier' : 'docs.header.customer')}
          </p>
          <p data-testid="preview-party">{d.partyName || t('docs.preview.cash')}</p>
          {d.partyGstin && <p>GSTIN: {d.partyGstin}</p>}
        </div>
        <div className="text-right">
          <p>
            {t('docs.header.pos')}:{' '}
            {d.placeOfSupply === '96'
              ? t('docs.header.outsideIndia')
              : (STATES[d.placeOfSupply] ?? '')}
          </p>
          {d.reverseCharge && <p className="font-semibold">{t('docs.preview.rcm')}</p>}
          {d.dueDate && (
            <p>
              {t('docs.header.dueDate')}: {d.dueDate}
            </p>
          )}
        </div>
      </section>

      <table className="w-full border-collapse" data-testid="preview-lines">
        <thead>
          <tr className="border-y border-black text-left">
            <th className="py-1">#</th>
            <th>{t('docs.grid.item')}</th>
            <th>{t('docs.grid.hsn')}</th>
            <th className="text-right">{t('docs.grid.qty')}</th>
            <th className="text-right">{t('docs.grid.rate')}</th>
            <th className="text-right">{t('docs.grid.taxable')}</th>
            <th className="text-right">{t('docs.grid.taxRate')}</th>
            <th className="text-right">{t('docs.grid.total')}</th>
          </tr>
        </thead>
        <tbody>
          {b.lines.map((l, i) => {
            const src = d.lines.find((x) => x.key === l.key)!;
            return (
              <tr
                key={l.key}
                className="border-b border-gray-300 align-top"
                data-testid="preview-line"
              >
                <td className="py-1">{i + 1}</td>
                <td>
                  {src.description}
                  {src.note && <div className="text-gray-600">{src.note}</div>}
                </td>
                <td>{src.hsn}</td>
                <td className="text-right">
                  {qtyText(src.qtyMicros)} {src.unitId ? (units.get(src.unitId) ?? '') : ''}
                </td>
                <td className="text-right">{toDecimalString(src.ratePaise)}</td>
                <td className="text-right">{toDecimalString(l.result.taxablePaise)}</td>
                <td className="text-right">{rateText(l.result.appliedRateBp)}%</td>
                <td className="text-right">{toDecimalString(l.result.totalPaise)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <section className="ml-auto mt-2 w-64">
        <Row label={t('docs.totals.taxable')} value={b.totals.taxablePaise} />
        {heads.map(([name, v]) => v > 0n && <Row key={name} label={name} value={v} />)}
        {b.totals.tcsPaise > 0n && <Row label="TCS" value={b.totals.tcsPaise} />}
        {b.totals.roundOffPaise !== 0n && (
          <Row label={t('docs.totals.roundOff')} value={b.totals.roundOffPaise} />
        )}
        <div className="flex justify-between border-t border-black pt-1 text-sm font-bold">
          <span>{t('docs.totals.total')}</span>
          <span data-testid="preview-total">
            <MoneyText paise={b.totals.totalPaise} />
          </span>
        </div>
        {foreign && (
          <p className="text-right" data-testid="preview-foreign">
            {d.currency} {toDecimalString(inForeign)} @ {Number(d.fxRateMicros) / 1_000_000}
          </p>
        )}
      </section>

      <p className="mt-2 font-semibold" data-testid="preview-words">
        {amountToWordsEn(b.totals.totalPaise)}
      </p>
      {declaration && <p className="mt-2 italic">{declaration}</p>}
      {notes && (
        <div
          className="mt-2"
          data-testid="preview-notes"
          dangerouslySetInnerHTML={{ __html: notes }}
        />
      )}
      {terms && (
        <div
          className="mt-2 text-[11px] text-gray-700"
          data-testid="preview-terms"
          dangerouslySetInnerHTML={{ __html: terms }}
        />
      )}
    </article>
  );
});

function Row({ label, value }: { label: string; value: bigint }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span>
        <MoneyText paise={value} />
      </span>
    </div>
  );
}

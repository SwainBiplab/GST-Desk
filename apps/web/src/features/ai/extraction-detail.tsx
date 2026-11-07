/**
 * The inbox card for a scanned bill: the scan on one side, the fields it was read into on the other,
 * each with the confidence it was read with, the lines, and the checks (does the engine's total match
 * the bill's, is the GSTIN valid, is the date sane). The edit dialog lets the person fix any field and
 * choose the supplier and the items before accepting.
 */
import type { AiExtractionItem } from '@gst/ai';
import { ItemRepo, type Row } from '@gst/db';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Badge,
  Button,
  Input,
  formatPaise,
} from '@gst/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PartyPicker } from '../documents/party-picker';
import type { InboxRow } from '../inbox/model';

import { getBlob } from '@/app/blobs';
import { useAppDb } from '@/app/db';
import { useTerm } from '@/lib/terms';

const tone = (c: number | undefined): 'success' | 'warning' | 'danger' =>
  c === undefined ? 'warning' : c >= 0.8 ? 'success' : c >= 0.5 ? 'warning' : 'danger';

function Confidence({ value }: { value: number | undefined }) {
  return (
    <Badge tone={tone(value)} className="tabular-nums" data-testid="field-confidence">
      {value === undefined ? '?' : `${Math.round(value * 100)}%`}
    </Badge>
  );
}

/** The scan itself, from the attachments store. */
export function ScanImage({ item }: { item: AiExtractionItem }) {
  const { t } = useTranslation();
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    if (item.attachment) {
      void getBlob(item.attachment.storagePath, item.attachment.mime).then((b) => {
        if (!live || !b) return;
        url = URL.createObjectURL(b);
        setHref(url);
      });
    }
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.attachment]);
  if (!item.attachment) return null;
  if (!href) return <div className="h-40 rounded bg-surface-2" />;
  return item.attachment.mime === 'application/pdf' ? (
    <iframe
      title={t('ai.scan.attachment')}
      src={href}
      className="h-64 w-full rounded border border-border"
      data-testid="scan-view"
    />
  ) : (
    <img
      src={href}
      alt={t('ai.scan.attachment')}
      className="max-h-64 w-full rounded border border-border object-contain"
      data-testid="scan-view"
    />
  );
}

export function ExtractionDetail({ row }: { row: InboxRow }) {
  const { t } = useTranslation();
  const term = useTerm();
  const v = row.suggestion as unknown as AiExtractionItem;
  const c = v.fieldConfidence;
  const field = (label: string, key: string, value: string) => (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="flex items-center gap-2" data-testid={`field-${key}`}>
        <span className="min-w-0 break-words">{value || '—'}</span>
        <Confidence value={c[key]} />
      </dd>
    </>
  );
  return (
    <div className="flex flex-col gap-3 py-2" data-testid="extraction-detail">
      <ScanImage item={v} />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
        {field(t('ai.fields.supplier'), 'supplierName', v.bill.supplierName)}
        {field(term('gstin'), 'supplierGstin', v.bill.supplierGstin ?? '')}
        {field(t('ai.fields.invoiceNumber'), 'invoiceNumber', v.bill.invoiceNumber)}
        {field(t('ai.fields.date'), 'date', v.bill.date)}
        {field(t('ai.fields.total'), 'totalPaise', formatPaise(v.bill.totalPaise))}
      </dl>
      <table className="w-full text-sm" data-testid="extraction-lines">
        <thead>
          <tr className="text-left text-xs text-fg-muted">
            <th className="font-normal">{t('ai.fields.line')}</th>
            <th className="font-normal">{term('hsn')}</th>
            <th className="text-right font-normal">{t('ai.fields.qty')}</th>
            <th className="text-right font-normal">{t('ai.fields.rate')}</th>
            <th className="text-right font-normal">{t('ai.fields.gst')}</th>
          </tr>
        </thead>
        <tbody>
          {v.bill.lines.map((l, i) => (
            <tr key={i}>
              <td className="pr-2">
                {l.description}
                {l.itemId ? (
                  <Badge tone="info" className="ml-1">
                    {t('ai.fields.matched')}
                  </Badge>
                ) : null}
              </td>
              <td className="pr-2">{l.hsn ?? '—'}</td>
              <td className="text-right tabular-nums">{l.qty}</td>
              <td className="text-right tabular-nums">{formatPaise(l.ratePaise)}</td>
              <td className="text-right tabular-nums">{l.gstRateBp / 100}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-wrap gap-2 text-xs" data-testid="extraction-checks">
        <li>
          <Badge tone={v.checks.totalsAgree ? 'success' : 'danger'}>
            {v.checks.totalsAgree
              ? t('ai.checks.totalsAgree')
              : t('ai.checks.totalsDiffer', { engine: formatPaise(v.checks.engineTotalPaise) })}
          </Badge>
        </li>
        {v.checks.gstinValid !== null && (
          <li>
            <Badge tone={v.checks.gstinValid ? 'success' : 'warning'}>
              {v.checks.gstinValid ? t('ai.checks.gstinOk') : t('ai.checks.gstinDoubtful')}
            </Badge>
          </li>
        )}
        {!v.checks.dateSane && (
          <li>
            <Badge tone="warning">{t('ai.checks.dateOdd')}</Badge>
          </li>
        )}
        <li>
          <Badge tone={v.supplierPartyId ? 'success' : 'warning'}>
            {v.supplierPartyId ? t('ai.checks.supplierKnown') : t('ai.checks.supplierNew')}
          </Badge>
        </li>
        <li>
          <Badge tone="neutral">
            {t('ai.checks.readBy', { by: v.model ?? t('ai.checks.rules') })}
          </Badge>
        </li>
      </ul>
      <p className="text-xs text-fg-muted">{t('ai.scan.acceptNote')}</p>
    </div>
  );
}

/** Pick a catalogue item for one line by typing part of its name. */
function ItemMatchField({
  value,
  name,
  onPick,
}: {
  value: string | null;
  name: string;
  onPick: (item: Row | null) => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [query, setQuery] = useState<string | null>(null);
  const [results, setResults] = useState<Row[]>([]);
  const seq = useRef(0);
  const look = (q: string) => {
    setQuery(q);
    const mine = ++seq.current;
    if (!q.trim() || !database || !ctx) return setResults([]);
    void new ItemRepo(database)
      .search(ctx, q, 6)
      .then((r) => mine === seq.current && setResults(r));
  };
  return (
    <div className="relative">
      <Input
        value={query ?? name}
        placeholder={t('ai.edit.itemPlaceholder')}
        aria-label={t('ai.edit.item')}
        onFocus={() => look(name)}
        onChange={(e) => look(e.target.value)}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        data-state={value ? 'matched' : 'free'}
      />
      {query !== null && results.length > 0 && (
        <ul
          className="absolute z-10 mt-1 w-full rounded border border-border bg-surface-1 shadow"
          role="listbox"
        >
          {results.map((r) => (
            <li key={String(r['id'])}>
              <button
                type="button"
                className="w-full px-2 py-1 text-left text-sm hover:bg-surface-2"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(r);
                  setQuery(null);
                }}
              >
                {String(r['name'])}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="w-full px-2 py-1 text-left text-xs text-fg-muted hover:bg-surface-2"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(null);
                setQuery(null);
              }}
            >
              {t('ai.edit.freeLine')}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

const num = (s: string, scale = 1): number => {
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * scale) : 0;
};

export function ExtractionEditDialog(props: {
  row: InboxRow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (value: AiExtractionItem) => void;
}) {
  const { t } = useTranslation();
  const term = useTerm();
  const start = props.row.suggestion as unknown as AiExtractionItem;
  const [v, setV] = useState<AiExtractionItem>(start);
  const [supplierName, setSupplierName] = useState(start.bill.supplierName);
  const bill = (patch: Partial<AiExtractionItem['bill']>) =>
    setV((x) => ({ ...x, bill: { ...x.bill, ...patch } }));
  const line = (i: number, patch: Partial<AiExtractionItem['bill']['lines'][number]>) =>
    setV((x) => ({
      ...x,
      bill: { ...x.bill, lines: x.bill.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) },
    }));
  const c = start.fieldConfidence;
  return (
    <AlertDialog open onOpenChange={(o) => !o && props.onCancel()}>
      <AlertDialogContent className="max-w-3xl" data-testid="extraction-edit">
        <AlertDialogTitle>{t('ai.edit.title')}</AlertDialogTitle>
        <AlertDialogDescription>{t('ai.edit.subtitle')}</AlertDialogDescription>
        <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
          <div className="min-w-0">
            <ScanImage item={v} />
          </div>
          <div className="flex flex-col gap-2 text-sm">
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                {t('ai.fields.supplier')} <Confidence value={c['supplierName']} />
              </span>
              <PartyPicker
                type="purchase_bill"
                name={supplierName}
                onPick={(p) => {
                  setSupplierName(p ? String(p['name']) : '');
                  setV((x) => ({
                    ...x,
                    supplierPartyId: p ? String(p['id']) : null,
                    bill: {
                      ...x.bill,
                      supplierName: p ? String(p['name']) : x.bill.supplierName,
                      supplierGstin: p
                        ? ((p['gstin'] as string | null) ?? x.bill.supplierGstin)
                        : x.bill.supplierGstin,
                    },
                  }));
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                {term('gstin')} <Confidence value={c['supplierGstin']} />
              </span>
              <Input
                value={v.bill.supplierGstin ?? ''}
                data-testid="edit-gstin"
                onChange={(e) =>
                  bill({ supplierGstin: e.target.value.toUpperCase().trim() || null })
                }
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  {t('ai.fields.invoiceNumber')} <Confidence value={c['invoiceNumber']} />
                </span>
                <Input
                  value={v.bill.invoiceNumber}
                  data-testid="edit-invoice-number"
                  onChange={(e) => bill({ invoiceNumber: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  {t('ai.fields.date')} <Confidence value={c['date']} />
                </span>
                <Input
                  type="date"
                  value={v.bill.date}
                  data-testid="edit-date"
                  onChange={(e) => bill({ date: e.target.value })}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="flex items-center gap-2">
                {t('ai.fields.total')} <Confidence value={c['totalPaise']} />
              </span>
              <Input
                inputMode="decimal"
                value={(v.bill.totalPaise / 100).toFixed(2)}
                data-testid="edit-total"
                onChange={(e) => bill({ totalPaise: num(e.target.value, 100) })}
              />
            </label>
          </div>
        </div>
        <table className="mt-2 w-full text-sm" data-testid="edit-lines">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th className="font-normal">{t('ai.fields.line')}</th>
              <th className="font-normal">{t('ai.edit.item')}</th>
              <th className="font-normal">{term('hsn')}</th>
              <th className="font-normal">{t('ai.fields.qty')}</th>
              <th className="font-normal">{t('ai.fields.rate')}</th>
              <th className="font-normal">{t('ai.fields.gst')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {v.bill.lines.map((l, i) => (
              <tr key={i}>
                <td className="pr-1">
                  <Input
                    value={l.description}
                    aria-label={t('ai.fields.line')}
                    onChange={(e) => line(i, { description: e.target.value })}
                  />
                </td>
                <td className="pr-1">
                  <ItemMatchField
                    value={l.itemId}
                    name={l.itemId ? l.description : ''}
                    onPick={(item) =>
                      line(
                        i,
                        item
                          ? {
                              itemId: String(item['id']),
                              description: String(item['name']),
                              hsn: (item['hsn'] as string | null) ?? l.hsn,
                              gstRateBp: Number(item['gst_rate_bp'] ?? l.gstRateBp),
                            }
                          : { itemId: null },
                      )
                    }
                  />
                </td>
                <td className="w-24 pr-1">
                  <Input
                    value={l.hsn ?? ''}
                    aria-label={term('hsn')}
                    onChange={(e) => line(i, { hsn: e.target.value.trim() || null })}
                  />
                </td>
                <td className="w-20 pr-1">
                  <Input
                    inputMode="decimal"
                    value={String(l.qty)}
                    aria-label={t('ai.fields.qty')}
                    onChange={(e) => line(i, { qty: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="w-28 pr-1">
                  <Input
                    inputMode="decimal"
                    value={(l.ratePaise / 100).toFixed(2)}
                    aria-label={t('ai.fields.rate')}
                    onChange={(e) => line(i, { ratePaise: num(e.target.value, 100) })}
                  />
                </td>
                <td className="w-20 pr-1">
                  <Input
                    inputMode="decimal"
                    value={String(l.gstRateBp / 100)}
                    aria-label={t('ai.fields.gst')}
                    onChange={(e) => line(i, { gstRateBp: num(e.target.value, 100) })}
                  />
                </td>
                <td>
                  <Button
                    variant="ghost"
                    aria-label={t('ai.edit.removeLine')}
                    onClick={() =>
                      setV((x) => ({
                        ...x,
                        bill: { ...x.bill, lines: x.bill.lines.filter((_, k) => k !== i) },
                      }))
                    }
                  >
                    ×
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button
          variant="ghost"
          className="self-start"
          onClick={() =>
            setV((x) => ({
              ...x,
              bill: {
                ...x.bill,
                lines: [
                  ...x.bill.lines,
                  {
                    description: '',
                    hsn: null,
                    qty: 1,
                    ratePaise: 0,
                    gstRateBp: 1800,
                    itemId: null,
                  },
                ],
              },
            }))
          }
        >
          {t('ai.edit.addLine')}
        </Button>
        <div className="flex justify-end gap-2 pt-3">
          <Button variant="ghost" onClick={props.onCancel}>
            {t('confirm.cancel')}
          </Button>
          <Button
            data-testid="extraction-confirm"
            disabled={props.busy || !v.bill.lines.length}
            onClick={() =>
              props.onConfirm({
                ...v,
                bill: { ...v.bill, supplierName: supplierName || v.bill.supplierName },
              })
            }
          >
            {t('inbox.actions.acceptEdited')}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

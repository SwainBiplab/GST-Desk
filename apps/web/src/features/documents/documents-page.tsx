import { DocumentFlowRepo, DocumentRepo, type Row } from '@gst/db';
import type { DocumentType } from '@gst/domain';
import {
  Badge,
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  MoneyText,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { editorPath } from './editor-page';
import { isPurchase } from './state';

import { useAppDb, useLiveQuery } from '@/app/db';
import { useAppNavigate, useLocationInfo } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { useFeatureFlags } from '@/features/business/hooks';
import { usePositions } from '@/features/payments/hooks';
import { PayStatusBadge } from '@/features/payments/status-badge';
import { BulkExportDialog } from '@/features/print/bulk-export';

const ALL_TYPES: DocumentType[] = [
  'tax_invoice',
  'bill_of_supply',
  'proforma',
  'quotation',
  'credit_note',
  'debit_note',
  'delivery_challan',
  'purchase_bill',
  'purchase_return',
  'expense',
];
const SHOWN = 300;

/**
 * Documents: drafts to carry on with, then everything issued or cancelled, newest first. Opening one
 * goes to the editor (read-only once issued). The full registers with totals arrive with reports.
 */
export function DocumentsPage({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const { search } = useLocationInfo();
  const { business, database, ctx } = useAppDb();
  const flags = useFeatureFlags();
  const purchasesOnly = search['kind'] === 'purchases';
  const [type, setType] = useState<'all' | DocumentType>('all');
  const [status, setStatus] = useState<'all' | 'issued' | 'cancelled'>('all');

  const drafts = useLiveQuery<Row[]>({
    tables: ['documents'],
    key: ['drafts'],
    fn: (d, c) => new DocumentFlowRepo(d).listDrafts(c, 50),
  });
  const issued = useLiveQuery<Row[]>({
    tables: ['documents'],
    key: ['issued'],
    fn: async (d, c) =>
      (await new DocumentRepo(d).listBy(c, { limit: 1000 })).filter((r) => r['status'] !== 'draft'),
  });

  const composition = business?.['scheme'] === 'composition';
  const creatable = ALL_TYPES.filter(
    (x) =>
      !(composition && (x === 'tax_invoice' || x === 'credit_note' || x === 'debit_note')) &&
      !(x === 'quotation' && !flags.quotations) &&
      !(x === 'delivery_challan' && !flags.challans) &&
      !(isPurchase(x) && !flags.purchases),
  );
  const inScope = (r: Row) => (purchasesOnly ? isPurchase(r['type']) : true);
  const draftRows = (drafts.data ?? []).filter(inScope);
  const rows = (issued.data ?? [])
    .filter(inScope)
    .filter(
      (r) => (type === 'all' || r['type'] === type) && (status === 'all' || r['status'] === status),
    )
    .slice(0, SHOWN);

  const positions = usePositions();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [exporting, setExporting] = useState<string[] | null>(null);
  const open = (r: Row) =>
    r['type'] === 'receipt_voucher'
      ? navigate(`/${shell}/payments`, { voucher: r['id'] })
      : navigate(editorPath(shell), { type: r['type'], id: r['id'] });
  const discard = async (r: Row) => {
    if (!database || !ctx) return;
    await new DocumentFlowRepo(database).discardDraft(ctx, r['id'], r['version']);
    toast.success(t('docs.list.discarded'));
  };

  return (
    <div className="flex flex-col gap-4" data-testid="documents-page">
      <PageHeader
        title={t(purchasesOnly ? 'docs.list.purchases' : 'nav.documents')}
        description={t('docs.list.count', { count: rows.length })}
        actions={
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <Button
                variant="outline"
                data-testid="bulk-export-button"
                onClick={() => setExporting([...selected])}
              >
                {t('print.bulk.exportButton', { count: selected.size })}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button data-testid="doc-new">{t('docs.list.new')}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {creatable
                  .filter((x) => (purchasesOnly ? isPurchase(x) : true))
                  .map((x) => (
                    <DropdownMenuItem
                      key={x}
                      data-testid={`doc-new-${x}`}
                      onSelect={() => navigate(editorPath(shell), { type: x })}
                    >
                      {t(`docs.types.${x}`)}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      {draftRows.length > 0 && (
        <section
          aria-label={t('docs.list.drafts')}
          className="rounded-md border border-border"
          data-testid="drafts-list"
        >
          <h2 className="border-b border-border p-2 text-sm font-semibold">
            {t('docs.list.drafts')} ({draftRows.length})
          </h2>
          <ul>
            {draftRows.map((r) => (
              <li
                key={r['id']}
                className="flex flex-wrap items-center gap-2 border-b border-border p-2 text-sm last:border-b-0"
                data-testid="draft-row"
              >
                <span className="w-32 text-fg-muted">{t(`docs.types.${r['type']}`)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {r['party_name'] || t('docs.preview.cash')}
                </span>
                <span className="text-fg-muted">{r['date']}</span>
                <MoneyText paise={BigInt(Number(r['total_paise']))} />
                <Button variant="outline" data-testid="draft-resume" onClick={() => open(r)}>
                  {t('docs.resume.resume')}
                </Button>
                <Button variant="ghost" data-testid="draft-discard" onClick={() => void discard(r)}>
                  {t('docs.actions.discard')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
          <SelectTrigger
            className="w-48"
            aria-label={t('docs.list.type')}
            data-testid="doc-filter-type"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('docs.list.allTypes')}</SelectItem>
            {ALL_TYPES.filter((x) => (purchasesOnly ? isPurchase(x) : true)).map((x) => (
              <SelectItem key={x} value={x}>
                {t(`docs.types.${x}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger
            className="w-40"
            aria-label={t('docs.list.status')}
            data-testid="doc-filter-status"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('docs.list.allStatus')}</SelectItem>
            <SelectItem value="issued">{t('docs.status.issued')}</SelectItem>
            <SelectItem value="cancelled">{t('docs.status.cancelled')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {rows.length === 0 && !issued.isLoading ? (
        <EmptyState
          title={t('docs.list.emptyTitle')}
          description={t('docs.list.emptyBody')}
          action={
            <Button onClick={() => navigate(editorPath(shell), {})}>{t('docs.list.new')}</Button>
          }
        />
      ) : (
        <div className="overflow-auto rounded-md border border-border">
          <table
            className="w-full text-sm"
            aria-label={t('nav.documents')}
            data-testid="documents-table"
          >
            <thead className="bg-surface-2 text-left text-xs text-fg-muted">
              <tr>
                <th className="w-8 p-2">
                  <Checkbox
                    aria-label={t('print.bulk.selectAll')}
                    data-testid="doc-select-all"
                    checked={rows.length > 0 && rows.every((r) => selected.has(r['id']))}
                    onCheckedChange={(v) =>
                      setSelected(
                        v === true ? new Set(rows.map((r) => r['id'] as string)) : new Set(),
                      )
                    }
                  />
                </th>
                <th className="p-2">{t('docs.list.number')}</th>
                <th className="p-2">{t('docs.list.type')}</th>
                <th className="p-2">{t('docs.header.date')}</th>
                <th className="p-2">{t('docs.list.party')}</th>
                <th className="p-2 text-right">{t('docs.totals.total')}</th>
                <th className="p-2">{t('docs.list.status')}</th>
                <th className="p-2">{t('docs.list.payment')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r['id']}
                  className="border-t border-border hover:bg-surface-1"
                  data-testid="document-row"
                >
                  <td className="p-2">
                    <Checkbox
                      aria-label={t('print.bulk.select', { number: r['number'] ?? '' })}
                      data-testid="doc-select"
                      checked={selected.has(r['id'])}
                      onCheckedChange={(v) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (v === true) next.add(r['id'] as string);
                          else next.delete(r['id'] as string);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="p-2">
                    <button
                      type="button"
                      className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      data-testid="document-open"
                      onClick={() => open(r)}
                    >
                      {r['number'] ?? '-'}
                    </button>
                  </td>
                  <td className="p-2">{t(`docs.types.${r['type']}`)}</td>
                  <td className="p-2">{r['date']}</td>
                  <td className="p-2">{r['party_name'] ?? ''}</td>
                  <td className="p-2 text-right">
                    <MoneyText paise={BigInt(Number(r['total_paise']))} negativeRed />
                  </td>
                  <td className="p-2">
                    <Badge>{t(`docs.status.${r['status']}`)}</Badge>
                  </td>
                  <td className="p-2">
                    {r['status'] === 'issued' && (
                      <PayStatusBadge position={positions.get(r['id'])} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {exporting && <BulkExportDialog ids={exporting} onClose={() => setExporting(null)} />}
    </div>
  );
}

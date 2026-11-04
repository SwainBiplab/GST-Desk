import type { BulkBatch, Row } from '@gst/db';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Input,
  MoneyText,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from '@gst/ui';
import { ArrowDown, ArrowUp } from '@gst/ui/icons';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BulkEditDialog } from './bulk-edit';
import { itemsCsv } from './csv';
import { trimZeros } from './form';
import { useItemList, useItemSearch, useUnits } from './hooks';
import { HsnMasterDialog } from './hsn-master-dialog';
import { RateAssistant } from './rate-assistant';
import { UnitsDialog } from './units-dialog';

import { useAppDb } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { downloadText } from '@/features/parties/csv';

type SortKey = 'name' | 'sku' | 'hsn' | 'sale' | 'gst';
const ROW_HEIGHT = 36;

interface Filters {
  kind: 'all' | 'goods' | 'service';
  status: 'active' | 'inactive' | 'all';
  overridden: boolean;
  noHsn: boolean;
}
const NO_FILTERS: Filters = { kind: 'all', status: 'active', overridden: false, noHsn: false };

/** Apply the list filters. */
export function filterItems(rows: readonly Row[], f: Filters): Row[] {
  return rows.filter(
    (r) =>
      (f.kind === 'all' || r['kind'] === f.kind) &&
      (f.status === 'all' || (f.status === 'active') === (r['is_active'] !== false)) &&
      (!f.overridden || !!r['gst_rate_overridden']) &&
      (!f.noHsn || !r['hsn']),
  );
}

const sortValue = (r: Row, k: SortKey): string | number =>
  k === 'name'
    ? String(r['name']).toLowerCase()
    : k === 'sku'
      ? String(r['sku'] ?? '').toLowerCase()
      : k === 'hsn'
        ? String(r['hsn'] ?? '')
        : k === 'sale'
          ? Number(r['sale_rate_paise'] ?? 0)
          : Number(r['gst_rate_bp'] ?? 0);

export function sortItems(rows: readonly Row[], key: SortKey, desc: boolean): Row[] {
  const dir = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

const COLS: {
  id: SortKey | 'unit' | 'kind' | 'tags' | 'status';
  sort?: SortKey;
  width: string;
  right?: boolean;
}[] = [
  { id: 'name', sort: 'name', width: 'minmax(12rem,2fr)' },
  { id: 'kind', width: '6rem' },
  { id: 'sku', sort: 'sku', width: '8rem' },
  { id: 'hsn', sort: 'hsn', width: '7rem' },
  { id: 'unit', width: '5rem' },
  { id: 'sale', sort: 'sale', width: '8rem', right: true },
  { id: 'gst', sort: 'gst', width: '6rem', right: true },
  { id: 'tags', width: 'minmax(6rem,1fr)' },
  { id: 'status', width: '6rem' },
];

/** Items: search, filter, sort, select for bulk edit, import and export. Virtualised for large catalogues. */
export function ItemList({
  shell,
  onApplied,
  lastBatch,
  onUndo,
}: {
  shell: Shell;
  onApplied: (batch: BulkBatch, count: number) => void;
  lastBatch: BulkBatch | null;
  onUndo: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const { database } = useAppDb();
  const list = useItemList();
  const unitList = useUnits().data;
  const [query, setQuery] = useState('');
  const search = useItemSearch(query);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'bulk' | 'units' | 'hsn' | null>(null);

  const all = useMemo(() => list.data ?? [], [list.data]);
  const unitCode = useMemo(
    () => new Map((unitList ?? []).map((u) => [u['id'] as string, u['code'] as string])),
    [unitList],
  );

  const shown = useMemo(() => {
    let rows: readonly Row[] = all;
    if (query.trim()) {
      const ids = search.data ?? [];
      const byId = new Map(all.map((r) => [r['id'], r]));
      rows = ids.map((id) => byId.get(id)).filter((r): r is Row => !!r);
    }
    const filtered = filterItems(rows, filters);
    // search results keep their relevance order until a column is chosen
    return query.trim() ? filtered : sortItems(filtered, sort.key, sort.desc);
  }, [all, query, search.data, filters, sort]);

  const chosen = shown.filter((r) => selected.has(r['id']));
  const allSelected = shown.length > 0 && shown.every((r) => selected.has(r['id']));
  const scroller = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const template = `2.5rem ${COLS.map((c) => c.width).join(' ')}`;

  const exportCsv = () => {
    const rows = chosen.length > 0 ? chosen : shown;
    downloadText('items.csv', itemsCsv(rows, unitCode));
  };
  const edit = (id: string) => navigate(`/${shell}/items`, { edit: id });
  const control = shell === 'shop' ? 'min-h-11' : '';

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="item-list">
      <PageHeader
        title={t('nav.items')}
        description={t('items.list.count', { count: shown.length, total: all.length })}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className={control}
              data-testid="units-open"
              onClick={() => setDialog('units')}
            >
              {t('items.units.manage')}
            </Button>
            <Button
              variant="outline"
              className={control}
              data-testid="hsn-open"
              onClick={() => setDialog('hsn')}
            >
              {t('items.hsnMaster.manage')}
            </Button>
            <Button
              variant="outline"
              className={control}
              data-testid="import-items"
              onClick={() => navigate(`/${shell}/items`, { import: '1' })}
            >
              {t('items.list.import')}
            </Button>
            <Button
              variant="outline"
              className={control}
              data-testid="export-items"
              onClick={exportCsv}
            >
              {t('items.list.export')}
            </Button>
            <Button
              className={control}
              data-testid="new-item"
              onClick={() => navigate(`/${shell}/items`, { new: '1' })}
            >
              {t('items.list.new')}
            </Button>
          </div>
        }
      />

      <RateAssistant onApplied={onApplied} />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          className="max-w-sm"
          aria-label={t('items.list.search')}
          placeholder={t('items.list.search')}
          data-testid="item-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          value={filters.kind}
          onValueChange={(kind) => setFilters({ ...filters, kind: kind as Filters['kind'] })}
        >
          <SelectTrigger
            className="w-36"
            aria-label={t('items.filters.kind')}
            data-testid="filter-kind"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('items.filters.allKinds')}</SelectItem>
            <SelectItem value="goods">{t('items.kinds.goods')}</SelectItem>
            <SelectItem value="service">{t('items.kinds.service')}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={filters.status}
          onValueChange={(status) =>
            setFilters({ ...filters, status: status as Filters['status'] })
          }
        >
          <SelectTrigger
            className="w-36"
            aria-label={t('items.filters.status')}
            data-testid="filter-status"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t('items.filters.active')}</SelectItem>
            <SelectItem value="inactive">{t('items.filters.inactive')}</SelectItem>
            <SelectItem value="all">{t('items.filters.allStatus')}</SelectItem>
          </SelectContent>
        </Select>
        {(['overridden', 'noHsn'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm" htmlFor={`f-${k}`}>
            <Checkbox
              id={`f-${k}`}
              data-testid={`filter-${k}`}
              checked={filters[k]}
              onCheckedChange={(v) => setFilters({ ...filters, [k]: v === true })}
            />
            {t(`items.filters.${k}`)}
          </label>
        ))}
        {JSON.stringify(filters) !== JSON.stringify(NO_FILTERS) && (
          <Button variant="ghost" onClick={() => setFilters(NO_FILTERS)}>
            {t('items.filters.clear')}
          </Button>
        )}
      </div>

      {(chosen.length > 0 || lastBatch) && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-1 p-2 text-sm"
          data-testid="item-bulk-bar"
        >
          {chosen.length > 0 && (
            <>
              <span>{t('items.list.selected', { count: chosen.length })}</span>
              <Button variant="outline" data-testid="bulk-open" onClick={() => setDialog('bulk')}>
                {t('items.bulk.open')}
              </Button>
              <Button variant="ghost" onClick={() => setSelected(new Set())}>
                {t('items.list.clearSelection')}
              </Button>
            </>
          )}
          {lastBatch && (
            <Button variant="outline" className="ml-auto" data-testid="bulk-undo" onClick={onUndo}>
              {t('items.bulk.undo', { count: lastBatch.entries.length })}
            </Button>
          )}
        </div>
      )}

      {all.length === 0 && !list.isLoading ? (
        <EmptyState
          title={t('items.list.emptyTitle')}
          description={t('items.list.emptyBody')}
          action={
            <Button onClick={() => navigate(`/${shell}/items`, { new: '1' })}>
              {t('items.list.new')}
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <p className="p-4 text-sm text-fg-muted" data-testid="item-none">
          {t('items.list.empty')}
        </p>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col rounded-md border border-border"
          data-testid="item-table"
        >
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-auto"
            role="table"
            aria-rowcount={shown.length + 1}
            aria-label={t('nav.items')}
          >
            <div
              role="row"
              className="sticky top-0 z-10 grid items-center border-b border-border bg-surface-2 text-left text-xs font-medium text-fg-muted"
              style={{ gridTemplateColumns: template }}
            >
              <div role="columnheader" className="px-2">
                <Checkbox
                  aria-label={t('items.list.selectAll')}
                  checked={allSelected}
                  onCheckedChange={(v) =>
                    setSelected(v === true ? new Set(shown.map((r) => r['id'])) : new Set())
                  }
                />
              </div>
              {COLS.map((c) => {
                const active = c.sort && sort.key === c.sort;
                return (
                  <div
                    key={c.id}
                    role="columnheader"
                    aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                    className={cn('px-2', c.right && 'text-right')}
                  >
                    {c.sort ? (
                      <button
                        type="button"
                        data-testid={`sort-${c.id}`}
                        className="inline-flex items-center gap-1 py-1 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => setSort({ key: c.sort!, desc: active ? !sort.desc : false })}
                      >
                        {t(`items.cols.${c.id}`)}
                        {active &&
                          (sort.desc ? (
                            <ArrowDown size={12} aria-hidden />
                          ) : (
                            <ArrowUp size={12} aria-hidden />
                          ))}
                      </button>
                    ) : (
                      t(`items.cols.${c.id}`)
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {virt.getVirtualItems().map((v) => {
                const r = shown[v.index]!;
                const id = r['id'] as string;
                return (
                  <div
                    key={id}
                    role="row"
                    aria-rowindex={v.index + 2}
                    data-testid="item-row"
                    data-item-id={id}
                    className={cn(
                      'absolute left-0 grid w-full items-center border-b border-border text-sm hover:bg-surface-1',
                      selected.has(id) && 'bg-surface-2',
                    )}
                    style={{
                      top: 0,
                      height: ROW_HEIGHT,
                      transform: `translateY(${v.start}px)`,
                      gridTemplateColumns: template,
                    }}
                  >
                    <div role="cell" className="px-2">
                      <Checkbox
                        aria-label={`${t('items.list.select')} ${r['name']}`}
                        checked={selected.has(id)}
                        onCheckedChange={(on) => {
                          const next = new Set(selected);
                          if (on === true) next.add(id);
                          else next.delete(id);
                          setSelected(next);
                        }}
                      />
                    </div>
                    <div role="cell" className="truncate px-2">
                      <button
                        type="button"
                        data-testid="item-open"
                        className="truncate font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => edit(id)}
                      >
                        {r['name']}
                      </button>
                    </div>
                    <div role="cell" className="truncate px-2">
                      {t(`items.kinds.${r['kind']}`)}
                    </div>
                    <div role="cell" className="truncate px-2">
                      {r['sku'] ?? ''}
                    </div>
                    <div role="cell" className="truncate px-2 tabular-nums">
                      {r['hsn'] ?? ''}
                    </div>
                    <div role="cell" className="truncate px-2">
                      {unitCode.get(r['unit_id']) ?? ''}
                    </div>
                    <div role="cell" className="px-2 text-right">
                      <MoneyText paise={BigInt(r['sale_rate_paise'] ?? 0)} />
                    </div>
                    <div role="cell" className="px-2 text-right tabular-nums">
                      {trimZeros(((r['gst_rate_bp'] ?? 0) / 100).toFixed(2))}%
                      {r['gst_rate_overridden'] ? (
                        <span title={t('items.list.overridden')}> *</span>
                      ) : null}
                    </div>
                    <div role="cell" className="truncate px-2 text-fg-muted">
                      {((r['tags_json'] ?? []) as string[]).join(', ')}
                    </div>
                    <div role="cell" className="px-2">
                      {r['is_active'] === false && (
                        <Badge>{t('items.filters.inactiveBadge')}</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {dialog === 'bulk' && (
        <BulkEditDialog
          items={chosen}
          onClose={() => setDialog(null)}
          onApplied={(b, n) => {
            setSelected(new Set());
            onApplied(b, n);
          }}
        />
      )}
      {dialog === 'units' && <UnitsDialog onClose={() => setDialog(null)} />}
      {dialog === 'hsn' && database && <HsnMasterDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

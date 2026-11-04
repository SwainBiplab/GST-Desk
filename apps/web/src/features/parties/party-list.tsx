import { PartyRepo, type PartyAccount, type Row } from '@gst/db';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
  toast,
} from '@gst/ui';
import { ArrowDown, ArrowUp, Columns3 } from '@gst/ui/icons';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { downloadText, partiesCsv, partiesImportCsv } from './csv';
import { stateName } from './form';
import { usePartyList, usePartySearch } from './hooks';
import { MergeDialog } from './merge';

import { useAppDb } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import type { Shell } from '@/app/store';

export interface PartyRow {
  id: string;
  row: Row;
  name: string;
  type: string;
  gstin: string;
  phone: string;
  city: string;
  state: string;
  stateCode: string;
  balance: bigint;
  overdue: bigint;
  creditDays: number;
  tags: string;
  unregistered: boolean;
}

interface Filters {
  type: string;
  state: string;
  outstanding: boolean;
  overdue: boolean;
  unregistered: boolean;
}
const NO_FILTERS: Filters = {
  type: 'all',
  state: 'all',
  outstanding: false,
  overdue: false,
  unregistered: false,
};

/** Apply the list filters. Customers include "both"; suppliers likewise. */
export function filterParties(rows: PartyRow[], f: Filters): PartyRow[] {
  return rows.filter(
    (r) =>
      (f.type === 'all' || r.type === f.type || r.type === 'both') &&
      (f.state === 'all' || r.stateCode === f.state) &&
      (!f.outstanding || r.balance > 0n) &&
      (!f.overdue || r.overdue > 0n) &&
      (!f.unregistered || r.unregistered),
  );
}

export function toPartyRows(parties: Row[], accounts: Map<string, PartyAccount>): PartyRow[] {
  return parties.map((p) => {
    const a = accounts.get(p['id']);
    return {
      id: p['id'],
      row: p,
      name: p['name'],
      type: p['type'],
      gstin: p['gstin'] ?? '',
      phone: p['phone'] ?? '',
      city: p['city'] ?? '',
      state: stateName(p['state_code']),
      stateCode: p['state_code'] ?? '',
      balance: a?.balancePaise ?? 0n,
      overdue: a?.overduePaise ?? 0n,
      creditDays: p['credit_days'] ?? 0,
      tags: ((p['tags_json'] ?? []) as string[]).join(', '),
      unregistered: !!p['is_unregistered'],
    };
  });
}

const COLS_KEY = 'gst.parties.cols';
const COLUMN_IDS = [
  'name',
  'type',
  'gstin',
  'phone',
  'city',
  'state',
  'balance',
  'overdue',
  'creditDays',
  'tags',
] as const;
const DEFAULT_VISIBLE: VisibilityState = { creditDays: false, tags: false, city: false };

function readVisibility(): VisibilityState {
  try {
    const raw = localStorage.getItem(COLS_KEY);
    if (raw) return JSON.parse(raw) as VisibilityState;
  } catch {
    /* ignore */
  }
  return DEFAULT_VISIBLE;
}

function FilterBar({
  value,
  onChange,
  states,
}: {
  value: Filters;
  onChange: (f: Filters) => void;
  states: [string, string][];
}) {
  const { t } = useTranslation();
  const toggle = (key: 'outstanding' | 'overdue' | 'unregistered') => (
    <label className="flex items-center gap-2 text-sm" htmlFor={`f-${key}`}>
      <Checkbox
        id={`f-${key}`}
        data-testid={`filter-${key}`}
        checked={value[key]}
        onCheckedChange={(v) => onChange({ ...value, [key]: v === true })}
      />
      {t(`parties.filters.${key}`)}
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="party-filters">
      <Select value={value.type} onValueChange={(type) => onChange({ ...value, type })}>
        <SelectTrigger
          aria-label={t('parties.filters.type')}
          className="w-36"
          data-testid="filter-type"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('parties.filters.allTypes')}</SelectItem>
          <SelectItem value="customer">{t('parties.types.customer')}</SelectItem>
          <SelectItem value="supplier">{t('parties.types.supplier')}</SelectItem>
        </SelectContent>
      </Select>
      <Select value={value.state} onValueChange={(state) => onChange({ ...value, state })}>
        <SelectTrigger
          aria-label={t('parties.filters.state')}
          className="w-44"
          data-testid="filter-state"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('parties.filters.allStates')}</SelectItem>
          {states.map(([code, name]) => (
            <SelectItem key={code} value={code}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {toggle('outstanding')}
      {toggle('overdue')}
      {toggle('unregistered')}
      {JSON.stringify(value) !== JSON.stringify(NO_FILTERS) && (
        <Button variant="ghost" onClick={() => onChange(NO_FILTERS)}>
          {t('parties.filters.clear')}
        </Button>
      )}
    </div>
  );
}

function TagDialog({ rows, onClose }: { rows: PartyRow[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [text, setText] = useState('');
  const run = async () => {
    if (!database || !ctx) return;
    const tags = text
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (tags.length === 0) return onClose();
    const repo = new PartyRepo(database);
    for (const r of rows) {
      const fresh = await repo.get(ctx, r.id);
      if (!fresh) continue;
      const union = [...new Set([...((fresh['tags_json'] ?? []) as string[]), ...tags])];
      await repo.update(ctx, r.id, { tags_json: union }, fresh['version']);
    }
    toast.success(t('parties.bulk.tagged', { count: rows.length }));
    onClose();
  };
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="tag-dialog">
        <AlertDialogTitle className="text-lg font-semibold">
          {t('parties.bulk.tagTitle', { count: rows.length })}
        </AlertDialogTitle>
        <AlertDialogDescription className="py-1 text-fg-muted">
          {t('parties.form.tagsHelp')}
        </AlertDialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
          className="flex flex-col gap-3"
        >
          <Input
            aria-label={t('parties.form.tags')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="tag-input"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('parties.form.cancel')}
            </Button>
            <Button type="submit" data-testid="tag-apply">
              {t('parties.bulk.apply')}
            </Button>
          </div>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const ROW_HEIGHT = 34;

/** Books: dense, virtualised table with configurable columns, sorting, filters and bulk actions. */
function BooksTable({
  rows,
  selected,
  setSelected,
  onOpen,
}: {
  rows: PartyRow[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'name', desc: false }]);
  const [visibility, setVisibility] = useState<VisibilityState>(readVisibility);

  const columns = useMemo<ColumnDef<PartyRow>[]>(
    () => [
      { id: 'name', accessorKey: 'name' },
      { id: 'type', accessorKey: 'type' },
      { id: 'gstin', accessorKey: 'gstin' },
      { id: 'phone', accessorKey: 'phone' },
      { id: 'city', accessorKey: 'city' },
      { id: 'state', accessorKey: 'state' },
      { id: 'balance', accessorFn: (r) => Number(r.balance) },
      { id: 'overdue', accessorFn: (r) => Number(r.overdue) },
      { id: 'creditDays', accessorKey: 'creditDays' },
      { id: 'tags', accessorKey: 'tags' },
    ],
    [],
  );
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnVisibility: visibility },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const sorted = table.getRowModel().rows;
  const visible = table.getVisibleLeafColumns();

  const scroller = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const template = `2.5rem ${visible.map((c) => (c.id === 'name' ? 'minmax(12rem,2fr)' : c.id === 'gstin' ? '11rem' : '8rem')).join(' ')}`;

  const toggleColumn = (id: string, on: boolean) => {
    const next = { ...visibility, [id]: on };
    setVisibility(next);
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div
      className="flex min-h-0 flex-1 flex-col rounded-md border border-border"
      data-testid="party-table"
    >
      <div className="flex items-center justify-end border-b border-border p-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" data-testid="columns-menu">
              <Columns3 size={14} aria-hidden /> {t('parties.list.columns')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {COLUMN_IDS.filter((id) => id !== 'name').map((id) => {
              const on = table.getColumn(id)?.getIsVisible() ?? true;
              return (
                <DropdownMenuItem
                  key={id}
                  data-testid={`col-${id}`}
                  onSelect={(e) => {
                    e.preventDefault();
                    toggleColumn(id, !on);
                  }}
                >
                  <span className="w-4">{on ? '✓' : ''}</span> {t(`parties.cols.${id}`)}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-auto"
        role="table"
        aria-rowcount={sorted.length + 1}
        aria-label={t('nav.parties')}
      >
        <div
          role="row"
          className="sticky top-0 z-10 grid items-center border-b border-border bg-surface-2 text-left text-xs font-medium text-fg-muted"
          style={{ gridTemplateColumns: template }}
        >
          <div role="columnheader" className="px-2">
            <Checkbox
              aria-label={t('parties.list.selectAll')}
              checked={allSelected}
              onCheckedChange={(v) =>
                setSelected(v === true ? new Set(rows.map((r) => r.id)) : new Set())
              }
            />
          </div>
          {visible.map((c) => {
            const dir = c.getIsSorted();
            return (
              <div
                key={c.id}
                role="columnheader"
                aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                className={cn('px-2', (c.id === 'balance' || c.id === 'overdue') && 'text-right')}
              >
                <button
                  type="button"
                  data-testid={`sort-${c.id}`}
                  className="inline-flex items-center gap-1 py-1 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={c.getToggleSortingHandler()}
                >
                  {t(`parties.cols.${c.id}`)}
                  {dir === 'asc' && <ArrowUp size={12} aria-hidden />}
                  {dir === 'desc' && <ArrowDown size={12} aria-hidden />}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((v) => {
            const r = sorted[v.index]!;
            const p = r.original;
            return (
              <div
                key={r.id}
                role="row"
                aria-rowindex={v.index + 2}
                data-testid="party-row"
                data-party-id={p.id}
                className={cn(
                  'absolute left-0 grid w-full items-center border-b border-border text-sm hover:bg-surface-1',
                  selected.has(p.id) && 'bg-surface-2',
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
                    aria-label={`${t('parties.list.select')} ${p.name}`}
                    checked={selected.has(p.id)}
                    onCheckedChange={(on) => {
                      const next = new Set(selected);
                      if (on === true) next.add(p.id);
                      else next.delete(p.id);
                      setSelected(next);
                    }}
                  />
                </div>
                {visible.map((c) => (
                  <div
                    key={c.id}
                    role="cell"
                    className={cn(
                      'truncate px-2',
                      (c.id === 'balance' || c.id === 'overdue') && 'text-right',
                    )}
                  >
                    {c.id === 'name' ? (
                      <button
                        type="button"
                        data-testid="party-open"
                        className="truncate font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => onOpen(p.id)}
                      >
                        {p.name}
                      </button>
                    ) : c.id === 'balance' || c.id === 'overdue' ? (
                      <MoneyText paise={c.id === 'balance' ? p.balance : p.overdue} negativeRed />
                    ) : c.id === 'type' ? (
                      t(`parties.types.${p.type}`)
                    ) : (
                      String(p[c.id as keyof PartyRow] ?? '')
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Shop: card list with search and quick filters. */
function ShopCards({ rows, onOpen }: { rows: PartyRow[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3" data-testid="party-cards">
      {rows.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => onOpen(p.id)}
            data-testid="party-card"
            className="w-full text-left focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Card className="flex min-h-11 items-center gap-3 hover:bg-surface-2">
              <span className="flex-1">
                <span className="block font-medium">{p.name}</span>
                <span className="block text-xs text-fg-muted">
                  {t(`parties.types.${p.type}`)}
                  {p.city ? ` | ${p.city}` : ''}
                  {p.phone ? ` | ${p.phone}` : ''}
                </span>
              </span>
              {p.balance !== 0n && (
                <span className="text-right">
                  <MoneyText paise={p.balance} negativeRed className="font-semibold" />
                  <span className="block text-xs text-fg-muted">
                    {p.balance > 0n ? t('parties.p360.owes') : t('parties.p360.oweThem')}
                  </span>
                </span>
              )}
              {p.overdue > 0n && <Badge tone="danger">{t('parties.filters.overdue')}</Badge>}
            </Card>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PartyList({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const { data, isLoading } = usePartyList();
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'tag' | 'merge' | null>(null);
  const search = usePartySearch(q);

  const all = useMemo(() => (data ? toPartyRows(data.parties, data.accounts) : []), [data]);
  const filtered = useMemo(() => {
    let rows = filterParties(all, filters);
    if (q.trim() && search.data) {
      const rank = new Map(search.data.map((id, i) => [id, i]));
      rows = rows.filter((r) => rank.has(r.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    } else if (q.trim()) {
      rows = [];
    }
    return rows;
  }, [all, filters, q, search.data]);
  const states = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of all) if (r.stateCode) m.set(r.stateCode, r.state);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);

  const chosen = filtered.filter((r) => selected.has(r.id));
  const open = (id: string) => navigate(`/${shell}/parties`, { open: id });

  const exportCsv = () => {
    const rows = chosen.length > 0 ? chosen : filtered;
    downloadText(
      'parties.csv',
      partiesCsv(
        rows.map((r) => ({
          name: r.name,
          type: r.type,
          gstin: r.gstin,
          phone: r.phone,
          city: r.city,
          state: r.state,
          balancePaise: r.balance,
          overduePaise: r.overdue,
        })),
      ),
    );
  };

  /** The same columns the import reads, so an export can be edited and imported again. */
  const exportForImport = () => {
    const rows = chosen.length > 0 ? chosen : filtered;
    downloadText(
      'parties-for-import.csv',
      partiesImportCsv(
        rows.map((r) => {
          const addresses = (r.row['addresses_json'] ?? []) as {
            kind?: string;
            line1?: string;
            pincode?: string;
          }[];
          const billing = addresses.find((a) => a.kind === 'billing') ?? addresses[0];
          return {
            name: r.name,
            tradeName: r.row['trade_name'] ?? '',
            type: r.type,
            gstin: r.gstin,
            phone: r.phone,
            email: r.row['email'] ?? '',
            address: billing?.line1 ?? '',
            city: r.city,
            state: r.state,
            pincode: billing?.pincode ?? '',
            creditDays: r.creditDays,
            openingPaise: BigInt(r.row['opening_balance_paise'] ?? 0),
            tags: r.tags,
          };
        }),
      ),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="party-list">
      <PageHeader
        title={t('nav.parties')}
        description={t('parties.list.count', { count: filtered.length, total: all.length })}
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => navigate(`/${shell}/parties`, { import: '1' })}
              data-testid="import-parties"
              className={shell === 'shop' ? 'min-h-11' : ''}
            >
              {t('parties.list.import')}
            </Button>
            <Button
              onClick={() => navigate(`/${shell}/parties`, { new: '1' })}
              data-testid="new-party"
              className={shell === 'shop' ? 'min-h-11' : ''}
            >
              {t('parties.list.new')}
            </Button>
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          placeholder={t('parties.list.search')}
          aria-label={t('parties.list.search')}
          data-testid="party-search"
          className="max-w-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <FilterBar value={filters} onChange={setFilters} states={states} />
      </div>

      {shell === 'books' && (
        <div className="flex flex-wrap items-center gap-2" data-testid="bulk-bar">
          <span className="text-sm text-fg-muted" aria-live="polite">
            {t('parties.list.selected', { count: chosen.length })}
          </span>
          <Button variant="outline" onClick={exportCsv} data-testid="export-csv">
            {t('parties.bulk.export')}
          </Button>
          <Button variant="outline" onClick={exportForImport} data-testid="export-import-csv">
            {t('parties.bulk.exportForImport')}
          </Button>
          <Button
            variant="outline"
            disabled={chosen.length === 0}
            onClick={() => setDialog('tag')}
            data-testid="bulk-tag"
          >
            {t('parties.bulk.tag')}
          </Button>
          <Button
            variant="outline"
            disabled={chosen.length !== 2}
            onClick={() => setDialog('merge')}
            data-testid="bulk-merge"
          >
            {t('parties.bulk.merge')}
          </Button>
        </div>
      )}

      {isLoading ? (
        <p className="text-fg-muted">{t('empty.loading')}</p>
      ) : filtered.length === 0 ? (
        <EmptyState title={t('parties.list.empty')} />
      ) : shell === 'books' ? (
        <BooksTable rows={filtered} selected={selected} setSelected={setSelected} onOpen={open} />
      ) : (
        <ShopCards rows={filtered} onOpen={open} />
      )}

      {dialog === 'tag' && (
        <TagDialog
          rows={chosen}
          onClose={() => {
            setDialog(null);
            setSelected(new Set());
          }}
        />
      )}
      {dialog === 'merge' && chosen.length === 2 && (
        <MergeDialog
          parties={[chosen[0]!.row, chosen[1]!.row]}
          onClose={() => {
            setDialog(null);
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}

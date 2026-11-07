import { GodownRepo, InventoryRepo, ItemRepo, type CountMatch, type Row } from '@gst/db';
import {
  ADJUST_REASONS,
  countSheetTemplate,
  parseCountSheet,
  parseQtyMicros,
  today,
  type CountSheet,
} from '@gst/domain';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@gst/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBatches, useGodowns } from './hooks';

import { useAppDb } from '@/app/db';
import { downloadText } from '@/features/parties/csv';
import { qtyText } from '@/features/reports/model';

interface EntryRow {
  key: number;
  item: {
    id: string;
    name: string;
    sku: string;
    onHandMicros: number;
    trackingMode: 'none' | 'batch' | 'serial';
  } | null;
  text: string;
  /** Batch-tracked items: the batch adjusted. */
  batchId: string | null;
  /** Serial-tracked items: the serials, as typed. */
  serials: string;
}

let nextKey = 1;
const blank = (): EntryRow => ({
  key: nextKey++,
  item: null,
  text: '',
  batchId: null,
  serials: '',
});
const TRACKED_ONLY = (r: Row) => !!r['track_stock'];

/** Type to find an item by SKU, barcode or name; Enter takes the first match. */
function ItemLookup({
  row,
  onPick,
  index,
}: {
  row: EntryRow;
  onPick: (item: NonNullable<EntryRow['item']>) => void;
  index: number;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<NonNullable<EntryRow['item']>[]>([]);
  // only the latest search may show its results
  const latest = useRef(0);

  const look = async (q: string) => {
    setQuery(q);
    const mine = ++latest.current;
    if (!database || !ctx || !q.trim()) {
      setFound([]);
      return;
    }
    const rows = (await new ItemRepo(database).search(ctx, q.trim(), 8)).filter(TRACKED_ONLY);
    const onHand = await new InventoryRepo(database).onHand(
      ctx,
      rows.map((r) => String(r['id'])),
    );
    if (mine !== latest.current) return;
    setFound(
      rows.map((r) => ({
        id: String(r['id']),
        name: String(r['name']),
        sku: String(r['sku'] ?? ''),
        onHandMicros: onHand.get(String(r['id'])) ?? 0,
        trackingMode: (String(r['tracking_mode'] ?? 'none') || 'none') as
          'none' | 'batch' | 'serial',
      })),
    );
  };
  const pick = (item: NonNullable<EntryRow['item']>) => {
    latest.current++;
    onPick(item);
    setQuery('');
    setFound([]);
  };

  if (row.item) {
    return (
      <div
        className="flex items-center justify-between gap-2"
        data-testid={`adjust-row-${index}-picked`}
      >
        <span className="truncate">
          {row.item.name} <span className="text-fg-muted">{row.item.sku}</span>
        </span>
        <span className="tabular text-xs text-fg-muted">
          {t('inventory.adjust.has', { qty: qtyText(row.item.onHandMicros) })}
        </span>
      </div>
    );
  }
  return (
    <div className="relative">
      <Input
        value={query}
        placeholder={t('inventory.adjust.findItem')}
        aria-label={t('inventory.adjust.findItem')}
        data-testid={`adjust-row-${index}-item`}
        onChange={(e) => void look(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && found[0]) {
            e.preventDefault();
            pick(found[0]);
          }
        }}
      />
      {found.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full rounded-md border border-border bg-bg p-1 shadow-md">
          {found.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                data-testid="adjust-item-result"
                className="flex w-full justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-surface-1"
                onClick={() => pick(f)}
              >
                <span className="truncate">
                  {f.name} <span className="text-fg-muted">{f.sku}</span>
                </span>
                <span className="tabular text-xs text-fg-muted">{qtyText(f.onHandMicros)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The batch of an item to adjust, with what it holds in the godown chosen. */
function BatchPick({
  itemId,
  godownId,
  value,
  index,
  onChange,
}: {
  itemId: string;
  godownId: string | null;
  value: string | null;
  index: number;
  onChange: (batchId: string | null) => void;
}) {
  const { t } = useTranslation();
  const batches = useBatches(itemId, godownId).data ?? [];
  return (
    <Select value={value ?? '__none'} onValueChange={(v) => onChange(v === '__none' ? null : v)}>
      <SelectTrigger
        aria-label={t('inventory.adjust.batch')}
        data-testid={`adjust-row-${index}-batch`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">{t('inventory.adjust.chooseBatch')}</SelectItem>
        {batches.map((b) => (
          <SelectItem key={b.id} value={b.id}>
            {b.batchNo}
            {b.expiryDate ? ` · ${b.expiryDate}` : ''} · {qtyText(b.onHandMicros)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Stock adjustment: type quantities for many items at once (add or remove, or set to what was
 * counted), or fill in a count sheet as a CSV and bring it in. Everything is booked in one go with a
 * reason, and shows up as movements on each item.
 */
export function AdjustSheet({
  initialItemId,
  onClose,
}: {
  initialItemId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [tab, setTab] = useState<'enter' | 'count'>('enter');
  const [mode, setMode] = useState<'delta' | 'set'>('delta');
  const [date, setDate] = useState(() => today(() => new Date()));
  const [reason, setReason] = useState<string>('count');
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<EntryRow[]>(() => [blank(), blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const godowns = useGodowns().data ?? [];
  const [godownId, setGodownId] = useState<string | null>(null);
  const godownOrDefault = godownId ?? godowns.find((g) => g.isDefault)?.id ?? null;

  // a row ready for the item this was opened from
  useEffect(() => {
    if (!initialItemId || !database || !ctx) return;
    void (async () => {
      const item = await new ItemRepo(database).get(ctx, initialItemId);
      if (!item || !item['track_stock']) return;
      const onHand = await new InventoryRepo(database).onHand(ctx, [initialItemId]);
      setRows((rs) => [
        {
          key: nextKey++,
          item: {
            id: initialItemId,
            name: String(item['name']),
            sku: String(item['sku'] ?? ''),
            onHandMicros: onHand.get(initialItemId) ?? 0,
            trackingMode: (String(item['tracking_mode'] ?? 'none') || 'none') as
              'none' | 'batch' | 'serial',
          },
          text: '',
          batchId: null,
          serials: '',
        },
        ...rs.slice(1),
      ]);
    })();
  }, [initialItemId, database, ctx]);

  const patch = (key: number, p: Partial<EntryRow>) =>
    setRows((rs) => {
      const next = rs.map((r) => (r.key === key ? { ...r, ...p } : r));
      // always a free row at the bottom
      return next.every((r) => r.item) ? [...next, blank()] : next;
    });

  /** The quantity typed on a row, or an error key. */
  const parsed = (r: EntryRow): { micros: number } | { error: string } | null => {
    if (!r.item || r.text.trim() === '') return null;
    const v = parseQtyMicros(r.text, { allowNegative: mode === 'delta' });
    if (v === null || v === undefined) return { error: t('inventory.adjust.badQty') };
    if (mode === 'delta' && v === 0) return { error: t('inventory.adjust.zero') };
    return { micros: v };
  };

  const used = rows.filter((r) => r.item && r.text.trim() !== '');
  const problems = used.filter((r) => 'error' in (parsed(r) ?? {}));

  const book = async () => {
    if (!database || !ctx) return;
    setBusy(true);
    setError(null);
    try {
      const repo = new InventoryRepo(database);
      const lines = used.map((r) => ({
        itemId: r.item!.id,
        v: (parsed(r) as { micros: number }).micros,
        batchId: r.batchId,
        serials: r.serials,
      }));
      const done =
        mode === 'delta'
          ? await repo.adjust(ctx, {
              date,
              reason,
              ...(note.trim() ? { note } : {}),
              lines: lines.map((l) => ({
                itemId: l.itemId,
                deltaMicros: l.v,
                godownId,
                batchId: l.batchId,
                ...(l.serials.trim()
                  ? { serials: l.serials.split(/[\s,;]+/).filter(Boolean) }
                  : {}),
              })),
            })
          : await repo.applyCount(ctx, {
              date,
              godownId,
              ...(note.trim() ? { note } : {}),
              counts: lines.map((l) => ({
                itemId: l.itemId,
                countedMicros: l.v,
                batchId: l.batchId,
              })),
            });
      toast.success(t('inventory.adjust.done', { count: done.adjusted.length }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------------------------------------------- count sheet */

  const [sheet, setSheet] = useState<{ read: CountSheet; match: CountMatch } | null>(null);

  const downloadSheet = async () => {
    if (!database || !ctx) return;
    const items = (await new ItemRepo(database).list(ctx)).filter(TRACKED_ONLY);
    const onHand = godownId
      ? new Map(
          (await new GodownRepo(database).stock(ctx))
            .filter((r) => r.godownId === godownId)
            .map((r) => [r.itemId, r.onHandMicros]),
        )
      : await new InventoryRepo(database).onHand(ctx);
    const csv = countSheetTemplate(
      items.map((i) => ({
        sku: String(i['sku'] ?? ''),
        name: String(i['name']),
        onHandMicros: onHand.get(String(i['id'])) ?? 0,
      })),
      qtyText,
    );
    const godownName = godowns.find((g) => g.id === godownId)?.name;
    downloadText(`count-sheet_${godownName ? `${godownName}_` : ''}${date}.csv`, csv);
  };

  const readFile = async (file: File) => {
    if (!database || !ctx) return;
    setError(null);
    const read = parseCountSheet(await file.text());
    const match = await new InventoryRepo(database).matchCount(ctx, read.rows, { godownId });
    setSheet({ read, match });
  };

  const applySheet = async () => {
    if (!database || !ctx || !sheet) return;
    setBusy(true);
    setError(null);
    try {
      const done = await new InventoryRepo(database).applyCount(ctx, {
        date,
        godownId,
        ...(note.trim() ? { note } : {}),
        counts: sheet.match.matched.map((m) => ({
          itemId: m.itemId,
          countedMicros: m.row.countedMicros,
        })),
      });
      toast.success(t('inventory.adjust.done', { count: done.adjusted.length }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unmatched = sheet
    ? sheet.match.missing.length +
      sheet.match.ambiguous.length +
      sheet.match.untracked.length +
      sheet.read.errors.length
    : 0;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[min(48rem,100vw)] overflow-auto" data-testid="adjust-sheet">
        <SheetTitle className="text-lg font-semibold">{t('inventory.adjust.title')}</SheetTitle>
        <SheetDescription className="pb-3 text-fg-muted">
          {t('inventory.adjust.help')}
        </SheetDescription>

        <div className="grid gap-3 pb-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="block pb-1 text-fg-muted">{t('inventory.adjust.date')}</span>
            <Input
              type="date"
              value={date}
              data-testid="adjust-date"
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </label>
          {tab === 'enter' && mode === 'delta' && (
            <div className="text-sm">
              <span className="block pb-1 text-fg-muted">{t('inventory.adjust.reason')}</span>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger
                  aria-label={t('inventory.adjust.reason')}
                  data-testid="adjust-reason"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADJUST_REASONS.filter((r) => r !== 'opening').map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`inventory.reason.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {godowns.length > 1 && (
            <div className="text-sm">
              <span className="block pb-1 text-fg-muted">{t('inventory.adjust.godown')}</span>
              <Select value={godownOrDefault ?? ''} onValueChange={(v) => setGodownId(v)}>
                <SelectTrigger
                  aria-label={t('inventory.adjust.godown')}
                  data-testid="adjust-godown"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {godowns.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <label className="text-sm sm:col-span-1">
            <span className="block pb-1 text-fg-muted">{t('inventory.adjust.note')}</span>
            <Input
              value={note}
              data-testid="adjust-note"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'enter' | 'count')}>
          <TabsList aria-label={t('inventory.adjust.title')}>
            <TabsTrigger value="enter" data-testid="adjust-tab-enter">
              {t('inventory.adjust.tabEnter')}
            </TabsTrigger>
            <TabsTrigger value="count" data-testid="adjust-tab-count">
              {t('inventory.adjust.tabCount')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="enter">
            <div className="flex items-center gap-2 py-2 text-sm">
              <span className="text-fg-muted">{t('inventory.adjust.mode')}</span>
              <Select value={mode} onValueChange={(v) => setMode(v as 'delta' | 'set')}>
                <SelectTrigger
                  className="w-64"
                  aria-label={t('inventory.adjust.mode')}
                  data-testid="adjust-mode"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="delta">{t('inventory.adjust.modeDelta')}</SelectItem>
                  <SelectItem value="set">{t('inventory.adjust.modeSet')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ul className="flex flex-col gap-2" data-testid="adjust-rows">
              {rows.map((r, i) => {
                const p = parsed(r);
                const after =
                  r.item && p && 'micros' in p
                    ? mode === 'delta'
                      ? r.item.onHandMicros + p.micros
                      : p.micros
                    : null;
                return (
                  <li
                    key={r.key}
                    className="grid grid-cols-[minmax(0,1fr)_8rem_7rem] items-start gap-2"
                  >
                    <div className="flex flex-col gap-1">
                      <ItemLookup row={r} index={i} onPick={(item) => patch(r.key, { item })} />
                      {r.item?.trackingMode === 'batch' && (
                        <BatchPick
                          itemId={r.item.id}
                          godownId={godownOrDefault}
                          value={r.batchId}
                          index={i}
                          onChange={(batchId) => patch(r.key, { batchId })}
                        />
                      )}
                      {r.item?.trackingMode === 'serial' && (
                        <Input
                          value={r.serials}
                          placeholder={t('inventory.adjust.serials')}
                          aria-label={t('inventory.adjust.serials')}
                          data-testid={`adjust-row-${i}-serials`}
                          onChange={(e) => patch(r.key, { serials: e.target.value })}
                        />
                      )}
                    </div>
                    <div>
                      <Input
                        inputMode="decimal"
                        className="tabular text-right"
                        value={r.text}
                        disabled={!r.item}
                        placeholder={
                          mode === 'delta'
                            ? t('inventory.adjust.qtyDelta')
                            : t('inventory.adjust.qtySet')
                        }
                        aria-label={t('inventory.adjust.qty')}
                        data-testid={`adjust-row-${i}-qty`}
                        onChange={(e) => patch(r.key, { text: e.target.value })}
                      />
                      {p && 'error' in p && <p className="pt-0.5 text-xs text-danger">{p.error}</p>}
                    </div>
                    <span
                      className="tabular pt-2 text-right text-xs text-fg-muted"
                      data-testid={`adjust-row-${i}-after`}
                    >
                      {after !== null ? t('inventory.adjust.becomes', { qty: qtyText(after) }) : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-end gap-2 pt-4">
              {error && (
                <p role="alert" className="mr-auto text-sm text-danger" data-testid="adjust-error">
                  {error}
                </p>
              )}
              <Button variant="ghost" onClick={onClose}>
                {t('inventory.adjust.cancel')}
              </Button>
              <Button
                data-testid="adjust-submit"
                disabled={busy || used.length === 0 || problems.length > 0}
                onClick={() => void book()}
              >
                {t('inventory.adjust.book', { count: used.length })}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="count">
            <p className="py-2 text-sm text-fg-muted">{t('inventory.count.help')}</p>
            <div className="flex flex-wrap items-center gap-2 pb-3">
              <Button
                variant="outline"
                data-testid="count-template"
                onClick={() => void downloadSheet()}
              >
                {t('inventory.count.download')}
              </Button>
              <label className="text-sm">
                <span className="sr-only">{t('inventory.count.choose')}</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  data-testid="count-file"
                  className="text-sm"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void readFile(f);
                  }}
                />
              </label>
            </div>

            {sheet && (
              <div data-testid="count-preview">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-fg-muted">
                    <tr>
                      <th className="p-1 font-medium">{t('inventory.count.item')}</th>
                      <th className="p-1 text-right font-medium">{t('inventory.count.system')}</th>
                      <th className="p-1 text-right font-medium">{t('inventory.count.counted')}</th>
                      <th className="p-1 text-right font-medium">
                        {t('inventory.count.difference')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.match.matched.map((m) => {
                      const diff = m.row.countedMicros - m.onHandMicros;
                      return (
                        <tr
                          key={m.itemId}
                          className="border-t border-border"
                          data-testid="count-row"
                        >
                          <td className="p-1">
                            {m.name} <span className="text-fg-muted">{m.sku}</span>
                          </td>
                          <td className="tabular p-1 text-right">{qtyText(m.onHandMicros)}</td>
                          <td className="tabular p-1 text-right">{qtyText(m.row.countedMicros)}</td>
                          <td
                            className={`tabular p-1 text-right ${diff < 0 ? 'text-danger' : ''}`}
                            data-testid="count-diff"
                          >
                            {diff === 0 ? '0' : `${diff > 0 ? '+' : ''}${qtyText(diff)}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {unmatched > 0 && (
                  <ul className="pt-2 text-sm text-danger" data-testid="count-errors">
                    {sheet.read.errors.map((e) => (
                      <li key={`e${e.line}`}>
                        {t('inventory.count.line', {
                          line: e.line,
                          reason: t(`inventory.count.reason.${e.reason}`),
                        })}
                      </li>
                    ))}
                    {sheet.match.missing.map((r) => (
                      <li key={`m${r.line}`}>
                        {t('inventory.count.line', {
                          line: r.line,
                          reason: t('inventory.count.reason.missing', { key: r.key }),
                        })}
                      </li>
                    ))}
                    {sheet.match.ambiguous.map((r) => (
                      <li key={`a${r.line}`}>
                        {t('inventory.count.line', {
                          line: r.line,
                          reason: t('inventory.count.reason.ambiguous', { key: r.key }),
                        })}
                      </li>
                    ))}
                    {sheet.match.untracked.map((r) => (
                      <li key={`u${r.line}`}>
                        {t('inventory.count.line', {
                          line: r.line,
                          reason: t('inventory.count.reason.untracked', { key: r.key }),
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-4">
              {error && (
                <p role="alert" className="mr-auto text-sm text-danger" data-testid="count-failed">
                  {error}
                </p>
              )}
              <Button variant="ghost" onClick={onClose}>
                {t('inventory.adjust.cancel')}
              </Button>
              <Button
                data-testid="count-apply"
                disabled={busy || !sheet || sheet.match.matched.length === 0}
                onClick={() => void applySheet()}
              >
                {t('inventory.count.apply', { count: sheet?.match.matched.length ?? 0 })}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

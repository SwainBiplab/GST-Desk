import {
  BatchRepo,
  GodownRepo,
  ItemRepo,
  SerialRepo,
  TransferRepo,
  type ExpiringRow,
  type Godown,
  type Serial,
  type Transfer,
  type TransferLineInput,
} from '@gst/db';
import { isExpired, parseQtyMicros, parseSerials, today } from '@gst/domain';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@gst/ui';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBatches, useGodownStock, useGodowns, useTransfers } from './hooks';

import { useConfirm } from '@/app/components/confirm';
import { useAppDb, useLiveQuery } from '@/app/db';
import { useAppNavigate, useLocationInfo } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { qtyText } from '@/features/reports/model';
import { dyn } from '@/lib/dyn-key';

const TABS = ['overview', 'godowns', 'batches', 'transfers', 'serials'] as const;
type Tab = (typeof TABS)[number];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const todayIso = () => today(() => new Date());

/**
 * Stock across godowns (prompt 51): what each godown holds, the godowns themselves and their reorder
 * levels, batches and their expiry, transfers between godowns, and where a serial number is.
 */
export function StockPage({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const { search } = useLocationInfo();
  const wanted =
    typeof search['tab'] === 'string' && (TABS as readonly string[]).includes(search['tab'])
      ? (search['tab'] as Tab)
      : 'overview';
  const [tab, setTab] = useState<Tab>(wanted);
  const [transferOpen, setTransferOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="stock-page">
      <PageHeader
        title={t('inventory.stock.title')}
        description={t('inventory.stock.subtitle')}
        actions={
          <Button data-testid="transfer-new" onClick={() => setTransferOpen(true)}>
            {t('inventory.stock.newTransfer')}
          </Button>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList aria-label={t('inventory.stock.title')}>
          {TABS.map((k) => (
            <TabsTrigger key={k} value={k} data-testid={`stock-tab-${k}`}>
              {t(dyn(`inventory.stock.tabs.${k}`))}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab
            shell={shell}
            initialItem={typeof search['item'] === 'string' ? search['item'] : ''}
          />
        </TabsContent>
        <TabsContent value="godowns">
          <GodownsTab />
        </TabsContent>
        <TabsContent value="batches">
          <BatchesTab />
        </TabsContent>
        <TabsContent value="transfers">
          <TransfersTab onNew={() => setTransferOpen(true)} />
        </TabsContent>
        <TabsContent value="serials">
          <SerialsTab shell={shell} />
        </TabsContent>
      </Tabs>
      {transferOpen && (
        <TransferDialog
          onClose={() => setTransferOpen(false)}
          onDone={() => {
            setTransferOpen(false);
            setTab('transfers');
          }}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------------- overview */

function OverviewTab({ shell, initialItem }: { shell: Shell; initialItem: string }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const godowns = useGodowns().data ?? [];
  const stock = useGodownStock();
  const transit = useLiveQuery<Map<string, number>>({
    tables: ['stock_transfers', 'stock_transfer_lines'],
    key: ['in-transit'],
    fn: (d, c) => new TransferRepo(d).inTransit(c),
  });
  const [q, setQ] = useState(initialItem ? '' : '');
  const rows = stock.data ?? [];
  // one row per item, one cell per godown
  const items = new Map<
    string,
    { name: string; sku: string; by: Map<string, number>; low: boolean }
  >();
  for (const r of rows) {
    const cur = items.get(r.itemId) ?? { name: r.name, sku: r.sku, by: new Map(), low: false };
    cur.by.set(r.godownId, r.onHandMicros);
    if (r.minMicros > 0 && r.onHandMicros < r.minMicros) cur.low = true;
    items.set(r.itemId, cur);
  }
  const needle = q.trim().toLowerCase();
  const shown = [...items.entries()].filter(
    ([id, i]) =>
      (!initialItem || id === initialItem) &&
      (needle === '' ||
        i.name.toLowerCase().includes(needle) ||
        i.sku.toLowerCase().includes(needle)),
  );
  return (
    <div className="flex flex-col gap-2" data-testid="stock-overview">
      <Input
        className="max-w-sm"
        placeholder={t('inventory.stock.search')}
        aria-label={t('inventory.stock.search')}
        data-testid="stock-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="overflow-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-1 text-left text-xs uppercase text-fg-muted">
            <tr>
              <th className="p-2 font-medium">{t('inventory.stock.item')}</th>
              {godowns.map((g) => (
                <th key={g.id} className="p-2 text-right font-medium">
                  {g.name}
                </th>
              ))}
              <th className="p-2 text-right font-medium">{t('inventory.stock.inTransit')}</th>
              <th className="p-2 text-right font-medium">{t('inventory.stock.total')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(([id, i]) => {
              const moving = transit.data?.get(id) ?? 0;
              const total = [...i.by.values()].reduce((s, v) => s + v, 0) + moving;
              return (
                <tr key={id} className="border-t border-border" data-testid="stock-overview-row">
                  <td className="p-2">
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() => navigate(`/${shell}/items`, { edit: id })}
                    >
                      {i.name}
                    </button>{' '}
                    <span className="text-fg-muted">{i.sku}</span>
                    {i.low && <Badge className="ml-2">{t('inventory.panel.low')}</Badge>}
                  </td>
                  {godowns.map((g) => (
                    <td
                      key={g.id}
                      className="tabular p-2 text-right"
                      data-testid={`stock-cell-${g.name}`}
                    >
                      {qtyText(i.by.get(g.id) ?? 0)}
                    </td>
                  ))}
                  <td className="tabular p-2 text-right">{moving ? qtyText(moving) : ''}</td>
                  <td
                    className="tabular p-2 text-right font-medium"
                    data-testid="stock-overview-total"
                  >
                    {qtyText(total)}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td className="p-2 text-fg-muted" colSpan={godowns.length + 3}>
                  {t('inventory.stock.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------- godowns */

function GodownsTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const confirm = useConfirm();
  const godowns = useGodowns(true).data ?? [];
  const stock = useGodownStock().data ?? [];
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [level, setLevel] = useState<{
    item: { id: string; name: string } | null;
    godownId: string;
    qty: string;
  }>({
    item: null,
    godownId: '',
    qty: '',
  });

  const add = async () => {
    if (!database || !ctx) return;
    try {
      await new GodownRepo(database).add(ctx, { name, code });
      setName('');
      setCode('');
      toast.success(t('inventory.godowns.added'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const act = async (g: Godown, what: 'default' | 'archive' | 'restore') => {
    if (!database || !ctx) return;
    const repo = new GodownRepo(database);
    try {
      if (what === 'default') await repo.setDefault(ctx, g.id);
      if (what === 'archive') {
        if (
          !(await confirm({
            title: t('inventory.godowns.archiveTitle', { name: g.name }),
            description: t('inventory.godowns.archiveHelp'),
          }))
        )
          return;
        await repo.archive(ctx, g.id, g.version);
      }
      if (what === 'restore') await repo.unarchive(ctx, g.id, g.version);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const saveLevel = async () => {
    if (!database || !ctx || !level.item || !level.godownId) return;
    const micros = parseQtyMicros(level.qty);
    if (micros === null || micros === undefined || micros < 0) {
      toast.error(t('inventory.adjust.badQty'));
      return;
    }
    try {
      await new GodownRepo(database).setLevel(ctx, level.item.id, level.godownId, micros);
      toast.success(t('inventory.godowns.levelSaved'));
      setLevel({ item: null, godownId: '', qty: '' });
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const levels = stock.filter((r) => r.minMicros > 0);

  return (
    <div className="flex flex-col gap-4" data-testid="stock-godowns">
      <table className="w-full max-w-2xl text-sm">
        <thead className="text-left text-xs uppercase text-fg-muted">
          <tr>
            <th className="p-2 font-medium">{t('inventory.godowns.name')}</th>
            <th className="p-2 font-medium">{t('inventory.godowns.code')}</th>
            <th className="p-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {godowns.map((g) => (
            <tr key={g.id} className="border-t border-border" data-testid="godown-row">
              <td className="p-2">
                {g.name}
                {g.isDefault && <Badge className="ml-2">{t('inventory.godowns.default')}</Badge>}
                {!g.isActive && <Badge className="ml-2">{t('inventory.godowns.archived')}</Badge>}
              </td>
              <td className="p-2 text-fg-muted">{g.code}</td>
              <td className="p-2 text-right">
                {!g.isDefault && g.isActive && (
                  <Button variant="ghost" onClick={() => void act(g, 'default')}>
                    {t('inventory.godowns.makeDefault')}
                  </Button>
                )}
                {!g.isDefault && g.isActive && (
                  <Button
                    variant="ghost"
                    data-testid="godown-archive"
                    onClick={() => void act(g, 'archive')}
                  >
                    {t('inventory.godowns.archive')}
                  </Button>
                )}
                {!g.isActive && (
                  <Button variant="ghost" onClick={() => void act(g, 'restore')}>
                    {t('inventory.godowns.restore')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex max-w-2xl flex-wrap items-end gap-2">
        <label className="flex flex-col text-sm">
          {t('inventory.godowns.name')}
          <Input value={name} data-testid="godown-name" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col text-sm">
          {t('inventory.godowns.code')}
          <Input
            className="w-28"
            value={code}
            data-testid="godown-code"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <Button
          data-testid="godown-add"
          disabled={name.trim().length < 2}
          onClick={() => void add()}
        >
          {t('inventory.godowns.add')}
        </Button>
      </div>

      <section className="flex flex-col gap-2" data-testid="godown-levels">
        <h3 className="text-base font-semibold">{t('inventory.godowns.levels')}</h3>
        <p className="text-sm text-fg-muted">{t('inventory.godowns.levelsHelp')}</p>
        <div className="flex max-w-3xl flex-wrap items-end gap-2">
          <ItemSearch
            value={level.item}
            onPick={(item) => setLevel({ ...level, item })}
            testId="level-item"
          />
          <Select
            value={level.godownId || '__none'}
            onValueChange={(v) => setLevel({ ...level, godownId: v === '__none' ? '' : v })}
          >
            <SelectTrigger
              className="w-44"
              aria-label={t('inventory.godowns.godown')}
              data-testid="level-godown"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">{t('inventory.godowns.godown')}</SelectItem>
              {godowns
                .filter((g) => g.isActive)
                .map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Input
            className="w-28"
            inputMode="decimal"
            placeholder={t('inventory.godowns.level')}
            aria-label={t('inventory.godowns.level')}
            data-testid="level-qty"
            value={level.qty}
            onChange={(e) => setLevel({ ...level, qty: e.target.value })}
          />
          <Button
            variant="outline"
            data-testid="level-save"
            disabled={!level.item || !level.godownId}
            onClick={() => void saveLevel()}
          >
            {t('inventory.godowns.saveLevel')}
          </Button>
        </div>
        {levels.length > 0 && (
          <table className="w-full max-w-3xl text-sm">
            <tbody>
              {levels.map((r) => (
                <tr
                  key={`${r.itemId}|${r.godownId}`}
                  className="border-t border-border"
                  data-testid="level-row"
                >
                  <td className="p-2">{r.name}</td>
                  <td className="p-2">{godowns.find((g) => g.id === r.godownId)?.name ?? ''}</td>
                  <td className="tabular p-2 text-right">
                    {qtyText(r.onHandMicros)} / {qtyText(r.minMicros)}
                    {r.onHandMicros < r.minMicros && (
                      <Badge className="ml-2">{t('inventory.panel.low')}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* --------------------------------------------------------------------------------- batches */

function BatchesTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [item, setItem] = useState<{ id: string; name: string } | null>(null);
  const [horizon, setHorizon] = useState('90');
  const days = Math.max(0, Number(horizon) || 0);
  const expiring = useLiveQuery<ExpiringRow[]>({
    tables: ['batches', 'stock_movements'],
    key: ['expiring', days],
    fn: (d, c) => new BatchRepo(d).expiring(c, todayIso(), days),
  });
  const batches = useBatches(item?.id ?? null);
  const day = todayIso();
  const edit = async (id: string, version: number, expiryDate: string) => {
    if (!database || !ctx) return;
    try {
      await new BatchRepo(database).edit(ctx, id, { expiryDate }, version);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-4" data-testid="stock-batches-tab">
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{t('inventory.batches.expiring')}</h3>
          <Input
            className="w-20"
            inputMode="numeric"
            value={horizon}
            aria-label={t('inventory.batches.withinDays')}
            data-testid="expiry-horizon"
            onChange={(e) => setHorizon(e.target.value)}
          />
          <span className="text-sm text-fg-muted">{t('inventory.batches.days')}</span>
        </div>
        <table className="w-full max-w-4xl text-sm" data-testid="expiring-table">
          <thead className="text-left text-xs uppercase text-fg-muted">
            <tr>
              <th className="p-2 font-medium">{t('inventory.stock.item')}</th>
              <th className="p-2 font-medium">{t('inventory.panel.batch')}</th>
              <th className="p-2 font-medium">{t('inventory.panel.expiry')}</th>
              <th className="p-2 text-right font-medium">{t('inventory.batches.daysLeft')}</th>
              <th className="p-2 text-right font-medium">{t('inventory.panel.qty')}</th>
            </tr>
          </thead>
          <tbody>
            {(expiring.data ?? []).map((r) => (
              <tr key={r.batchId} className="border-t border-border" data-testid="expiring-row">
                <td className="p-2">{r.itemName}</td>
                <td className="p-2">{r.batchNo}</td>
                <td className="p-2">{r.expiryDate}</td>
                <td className={`tabular p-2 text-right ${r.daysLeft < 0 ? 'text-danger' : ''}`}>
                  {r.daysLeft < 0
                    ? t('inventory.batches.expiredAgo', { days: -r.daysLeft })
                    : r.daysLeft}
                </td>
                <td className="tabular p-2 text-right">{qtyText(r.onHandMicros)}</td>
              </tr>
            ))}
            {expiring.data && expiring.data.length === 0 && (
              <tr>
                <td className="p-2 text-fg-muted" colSpan={5}>
                  {t('inventory.batches.none')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-base font-semibold">{t('inventory.batches.ofItem')}</h3>
        <ItemSearch value={item} onPick={setItem} testId="batch-item" />
        {item && (
          <table className="w-full max-w-4xl text-sm" data-testid="item-batches">
            <thead className="text-left text-xs uppercase text-fg-muted">
              <tr>
                <th className="p-2 font-medium">{t('inventory.panel.batch')}</th>
                <th className="p-2 font-medium">{t('inventory.details.mfg')}</th>
                <th className="p-2 font-medium">{t('inventory.panel.expiry')}</th>
                <th className="p-2 text-right font-medium">{t('inventory.panel.qty')}</th>
              </tr>
            </thead>
            <tbody>
              {(batches.data ?? []).map((b) => (
                <tr key={b.id} className="border-t border-border" data-testid="item-batch-row">
                  <td className="p-2">
                    {b.batchNo}
                    {b.expiryDate && isExpired(b.expiryDate, day) && (
                      <Badge className="ml-2">{t('inventory.panel.expired')}</Badge>
                    )}
                  </td>
                  <td className="p-2 text-fg-muted">{b.mfgDate ?? '—'}</td>
                  <td className="p-2">
                    <Input
                      type="date"
                      className="w-40"
                      defaultValue={b.expiryDate ?? ''}
                      aria-label={t('inventory.panel.expiry')}
                      onBlur={(e) => {
                        if (e.target.value !== (b.expiryDate ?? ''))
                          void edit(b.id, b.version, e.target.value);
                      }}
                    />
                  </td>
                  <td className="tabular p-2 text-right">{qtyText(b.onHandMicros)}</td>
                </tr>
              ))}
              {batches.data && batches.data.length === 0 && (
                <tr>
                  <td className="p-2 text-fg-muted" colSpan={4}>
                    {t('inventory.details.noBatches')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* --------------------------------------------------------------------------------- transfers */

function TransfersTab({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const confirm = useConfirm();
  const transfers = useTransfers().data ?? [];
  const godowns = useGodowns(true).data ?? [];
  const name = (id: string) => godowns.find((g) => g.id === id)?.name ?? '';
  const receive = async (tr: Transfer) => {
    if (!database || !ctx) return;
    try {
      await new TransferRepo(database).receive(ctx, tr.id, tr.version, todayIso());
      toast.success(t('inventory.transfers.received'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const cancel = async (tr: Transfer) => {
    if (!database || !ctx) return;
    if (
      !(await confirm({
        title: t('inventory.transfers.cancelTitle', { number: tr.number }),
        description: t('inventory.transfers.cancelHelp'),
      }))
    )
      return;
    try {
      await new TransferRepo(database).cancel(
        ctx,
        tr.id,
        tr.version,
        'Cancelled from the stock page',
      );
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="stock-transfers">
      {transfers.length === 0 && (
        <p className="text-sm text-fg-muted">
          {t('inventory.transfers.empty')}{' '}
          <Button variant="ghost" onClick={onNew}>
            {t('inventory.stock.newTransfer')}
          </Button>
        </p>
      )}
      {transfers.map((tr) => (
        <div
          key={tr.id}
          className="rounded-md border border-border p-3 text-sm"
          data-testid="transfer-row"
          data-status={tr.status}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{tr.number}</span>
            <span className="text-fg-muted">{tr.date}</span>
            <span>
              {name(tr.fromGodownId)} → {name(tr.toGodownId)}
            </span>
            <Badge data-testid="transfer-status">
              {t(dyn(`inventory.transfers.status.${tr.status}`))}
            </Badge>
            {tr.status === 'dispatched' && (
              <span className="ml-auto flex gap-1">
                <Button
                  variant="outline"
                  data-testid="transfer-receive"
                  onClick={() => void receive(tr)}
                >
                  {t('inventory.transfers.receive')}
                </Button>
                <Button
                  variant="ghost"
                  data-testid="transfer-cancel"
                  onClick={() => void cancel(tr)}
                >
                  {t('inventory.transfers.cancel')}
                </Button>
              </span>
            )}
          </div>
          <ul className="pt-1 text-fg-muted">
            {tr.lines.map((l) => (
              <li key={l.id}>
                {l.name} · {qtyText(l.qtyMicros)}
                {l.batchNo ? ` · ${l.batchNo}` : ''}
                {l.serials.length > 0 ? ` · ${l.serials.join(', ')}` : ''}
              </li>
            ))}
          </ul>
          {tr.note && <p className="pt-1 text-xs text-fg-muted">{tr.note}</p>}
        </div>
      ))}
    </div>
  );
}

interface TransferLineDraft {
  key: number;
  item: { id: string; name: string; trackingMode: 'none' | 'batch' | 'serial' } | null;
  batchId: string | null;
  serials: string;
  qty: string;
}
let lineKey = 0;
const blankLine = (): TransferLineDraft => ({
  key: ++lineKey,
  item: null,
  batchId: null,
  serials: '',
  qty: '',
});

function TransferDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const godowns = useGodowns().data ?? [];
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [date, setDate] = useState(todayIso());
  const [immediate, setImmediate] = useState(true);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<TransferLineDraft[]>([blankLine()]);
  const [busy, setBusy] = useState(false);
  const fromId = from || godowns.find((g) => g.isDefault)?.id || '';
  const patch = (key: number, p: Partial<TransferLineDraft>) =>
    setLines((ls) => {
      const next = ls.map((l) => (l.key === key ? { ...l, ...p } : l));
      return next.every((l) => l.item) ? [...next, blankLine()] : next;
    });
  const submit = async () => {
    if (!database || !ctx) return;
    const used = lines.filter((l) => l.item);
    const input: TransferLineInput[] = [];
    for (const l of used) {
      const serials = l.item!.trackingMode === 'serial' ? parseSerials(l.serials).serials : [];
      const qty =
        l.item!.trackingMode === 'serial'
          ? serials.length * 1_000_000
          : (parseQtyMicros(l.qty) ?? 0);
      input.push({ itemId: l.item!.id, batchId: l.batchId, serials, qtyMicros: qty ?? 0 });
    }
    setBusy(true);
    try {
      await new TransferRepo(database).dispatch(ctx, {
        date,
        fromGodownId: fromId,
        toGodownId: to,
        immediate,
        note,
        lines: input,
      });
      toast.success(
        immediate ? t('inventory.transfers.done') : t('inventory.transfers.dispatched'),
      );
      onDone();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="transfer-dialog">
        <DialogTitle>{t('inventory.transfers.title')}</DialogTitle>
        <DialogDescription>{t('inventory.transfers.help')}</DialogDescription>
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            {t('inventory.transfers.from')}
            <Select value={fromId} onValueChange={setFrom}>
              <SelectTrigger data-testid="transfer-from" aria-label={t('inventory.transfers.from')}>
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
          </label>
          <label className="flex flex-col gap-1">
            {t('inventory.transfers.to')}
            <Select value={to || '__none'} onValueChange={(v) => setTo(v === '__none' ? '' : v)}>
              <SelectTrigger data-testid="transfer-to" aria-label={t('inventory.transfers.to')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">{t('inventory.transfers.chooseGodown')}</SelectItem>
                {godowns
                  .filter((g) => g.id !== fromId)
                  .map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            {t('inventory.transfers.date')}
            <Input
              type="date"
              value={date}
              data-testid="transfer-date"
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </label>
        </div>
        <ul className="flex flex-col gap-2 py-2" data-testid="transfer-lines">
          {lines.map((l, i) => (
            <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_10rem_7rem] items-start gap-2">
              <div className="flex flex-col gap-1">
                <ItemSearch
                  value={l.item}
                  onPick={(item) => patch(l.key, { item, batchId: null, serials: '' })}
                  testId={`transfer-line-${i}-item`}
                  withTracking
                />
                {l.item?.trackingMode === 'serial' && (
                  <Input
                    value={l.serials}
                    placeholder={t('inventory.adjust.serials')}
                    aria-label={t('inventory.adjust.serials')}
                    data-testid={`transfer-line-${i}-serials`}
                    onChange={(e) => patch(l.key, { serials: e.target.value })}
                  />
                )}
              </div>
              {l.item?.trackingMode === 'batch' ? (
                <TransferBatchPick
                  itemId={l.item.id}
                  godownId={fromId}
                  value={l.batchId}
                  index={i}
                  onChange={(batchId) => patch(l.key, { batchId })}
                />
              ) : (
                <span />
              )}
              <Input
                inputMode="decimal"
                className="tabular text-right"
                placeholder={t('inventory.adjust.qty')}
                aria-label={t('inventory.adjust.qty')}
                data-testid={`transfer-line-${i}-qty`}
                disabled={!l.item || l.item.trackingMode === 'serial'}
                value={
                  l.item?.trackingMode === 'serial'
                    ? String(parseSerials(l.serials).serials.length)
                    : l.qty
                }
                onChange={(e) => patch(l.key, { qty: e.target.value })}
              />
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            <Switch
              checked={immediate}
              data-testid="transfer-immediate"
              onCheckedChange={(v) => setImmediate(v === true)}
            />
            {t('inventory.transfers.immediate')}
          </label>
          <Input
            className="flex-1"
            placeholder={t('inventory.adjust.note')}
            aria-label={t('inventory.adjust.note')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {t('inventory.adjust.cancel')}
          </Button>
          <Button
            data-testid="transfer-submit"
            disabled={busy || !to || !lines.some((l) => l.item)}
            onClick={() => void submit()}
          >
            {immediate ? t('inventory.transfers.move') : t('inventory.transfers.dispatch')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TransferBatchPick({
  itemId,
  godownId,
  value,
  index,
  onChange,
}: {
  itemId: string;
  godownId: string;
  value: string | null;
  index: number;
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const batches = useBatches(itemId, godownId || null).data ?? [];
  return (
    <Select value={value ?? '__none'} onValueChange={(v) => onChange(v === '__none' ? null : v)}>
      <SelectTrigger
        aria-label={t('inventory.adjust.batch')}
        data-testid={`transfer-line-${index}-batch`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">{t('inventory.adjust.chooseBatch')}</SelectItem>
        {batches
          .filter((b) => b.onHandMicros > 0)
          .map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.batchNo} · {qtyText(b.onHandMicros)}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

/* --------------------------------------------------------------------------------- serials */

function SerialsTab({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const navigate = useAppNavigate();
  const godowns = useGodowns(true).data ?? [];
  const [q, setQ] = useState('');
  const [found, setFound] = useState<
    | (Serial & {
        itemName: string;
        history: { date: string; note: string; qtyMicros: number }[];
      })[]
    | null
  >(null);
  const look = async () => {
    if (!database || !ctx || !q.trim()) return;
    const serials = new SerialRepo(database);
    const hits = await serials.find(ctx, q);
    const items = new ItemRepo(database);
    setFound(
      await Promise.all(
        hits.map(async (s) => ({
          ...s,
          itemName: String((await items.get(ctx, s.itemId))?.['name'] ?? ''),
          history: await serials.history(ctx, s.itemId, s.serialNo),
        })),
      ),
    );
  };
  return (
    <div className="flex flex-col gap-3" data-testid="stock-serials-tab">
      <form
        className="flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void look();
        }}
      >
        <Input
          value={q}
          placeholder={t('inventory.serials.find')}
          aria-label={t('inventory.serials.find')}
          data-testid="serial-query"
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" data-testid="serial-find">
          {t('inventory.serials.look')}
        </Button>
      </form>
      {found && found.length === 0 && (
        <p className="text-sm text-fg-muted">{t('inventory.serials.none')}</p>
      )}
      {found?.map((s) => (
        <div
          key={s.id}
          className="rounded-md border border-border p-3 text-sm"
          data-testid="serial-result"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.serialNo}</span>
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => navigate(`/${shell}/items`, { edit: s.itemId })}
            >
              {s.itemName}
            </button>
            <Badge data-testid="serial-status">
              {t(dyn(`inventory.serials.status.${s.status}`))}
            </Badge>
            {s.status === 'in_stock' && (
              <span className="text-fg-muted">
                {s.godownId
                  ? godowns.find((g) => g.id === s.godownId)?.name
                  : t('inventory.serials.inTransit')}
              </span>
            )}
          </div>
          <ul className="pt-1 text-fg-muted">
            {s.history.map((h, i) => (
              <li key={i}>
                {h.date} · {h.note} · {h.qtyMicros > 0 ? '+' : ''}
                {qtyText(h.qtyMicros)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------------- shared */

function ItemSearch({
  value,
  onPick,
  testId,
  withTracking,
}: {
  value: { id: string; name: string } | null;
  onPick: (item: { id: string; name: string; trackingMode: 'none' | 'batch' | 'serial' }) => void;
  testId: string;
  withTracking?: boolean;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<
    { id: string; name: string; sku: string; trackingMode: 'none' | 'batch' | 'serial' }[]
  >([]);
  const latest = useRef(0);
  const look = async (text: string) => {
    setQ(text);
    const mine = ++latest.current;
    if (!database || !ctx || !text.trim()) {
      setFound([]);
      return;
    }
    const rows = (await new ItemRepo(database).search(ctx, text.trim(), 8)).filter(
      (r) => r['track_stock'],
    );
    if (mine !== latest.current) return;
    setFound(
      rows.map((r) => ({
        id: String(r['id']),
        name: String(r['name']),
        sku: String(r['sku'] ?? ''),
        trackingMode: (String(r['tracking_mode'] ?? 'none') || 'none') as
          'none' | 'batch' | 'serial',
      })),
    );
  };
  const pick = (f: (typeof found)[number]) => {
    latest.current++;
    onPick(f);
    setQ('');
    setFound([]);
  };
  void withTracking;
  if (value)
    return (
      <div
        className="flex items-center justify-between gap-2 text-sm"
        data-testid={`${testId}-picked`}
      >
        <span className="truncate">{value.name}</span>
      </div>
    );
  return (
    <div className="relative min-w-48">
      <Input
        value={q}
        placeholder={t('inventory.adjust.findItem')}
        aria-label={t('inventory.adjust.findItem')}
        data-testid={testId}
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
                data-testid={`${testId}-result`}
                className="flex w-full justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-surface-1"
                onClick={() => pick(f)}
              >
                <span className="truncate">
                  {f.name} <span className="text-fg-muted">{f.sku}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

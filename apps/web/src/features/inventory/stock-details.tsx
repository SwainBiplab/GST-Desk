import { BatchRepo, ItemRepo, SerialRepo, type Row } from '@gst/db';
import {
  checkSerials,
  fefoOrder,
  isExpired,
  parseSerials,
  stockEffectOf,
  today,
  type DraftLine,
  type DocumentType,
} from '@gst/domain';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBatches, useGodowns } from './hooks';

import { useAppDb, useLiveQuery } from '@/app/db';
import { qtyText } from '@/features/reports/model';

const NONE = '__none';

/**
 * Where a line's goods come from or go to (prompt 51): the godown, the batch (or first expiry first),
 * and the serial numbers, pasted or scanned one per line. Checked against what is in stock before
 * the editor takes them, so an issue does not fail for a serial that is not there.
 */
export function StockDetailsDialog({
  line,
  type,
  reduceStock,
  onApply,
  onClose,
}: {
  line: DraftLine;
  type: DocumentType;
  reduceStock: boolean;
  onApply: (patch: Partial<DraftLine>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const direction = stockEffectOf(type, { reduceStock });
  const godownsQuery = useGodowns();
  const godowns = godownsQuery.data ?? [];
  const item = useLiveQuery<Row | null>({
    tables: ['items'],
    key: ['stock-details-item', line.itemId],
    enabled: !!line.itemId,
    fn: (d, c) => new ItemRepo(d).get(c, line.itemId!),
  });
  const mode = (String(item.data?.['tracking_mode'] ?? 'none') || 'none') as
    'none' | 'batch' | 'serial';
  const defaultGodown =
    (item.data?.['default_godown_id'] as string | null) ??
    godowns.find((g) => g.isDefault)?.id ??
    null;
  const [godownId, setGodownId] = useState<string | null>(line.godownId);
  const [batchId, setBatchId] = useState<string | null>(line.batchId);
  const [serialText, setSerialText] = useState(line.serials.join('\n'));
  const [newBatch, setNewBatch] = useState({ no: '', expiry: '', mfg: '', mrp: '' });
  const [check, setCheck] = useState<{ unavailable: string[]; alreadyIn: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const effectiveGodown = godownId ?? defaultGodown;
  // the batches of this godown: not before the godowns are known, or the list would flash the total
  const batches = useBatches(
    mode === 'batch' && godownsQuery.isSuccess ? line.itemId : null,
    direction === 'out' ? effectiveGodown : null,
  );

  const day = today(() => new Date());

  const parsed = parseSerials(serialText);
  const serialCount = parsed.serials.length;

  // check the serials against the stock as they are typed, a moment after the last keystroke
  useEffect(() => {
    if (mode !== 'serial' || !database || !ctx || !line.itemId || !direction) return;
    const serials = parseSerials(serialText).serials;
    if (serials.length === 0) return;
    const timer = setTimeout(() => {
      void new SerialRepo(database)
        .states(ctx, line.itemId!, serials, direction === 'out' ? effectiveGodown : null)
        .then((states) => setCheck(checkSerials(serials, states, direction)));
    }, 250);
    return () => clearTimeout(timer);
  }, [serialText, mode, database, ctx, line.itemId, direction, effectiveGodown]);

  const addBatch = async () => {
    if (!database || !ctx || !line.itemId) return;
    setBusy(true);
    try {
      const b = await new BatchRepo(database).ensure(ctx, {
        itemId: line.itemId,
        batchNo: newBatch.no,
        expiryDate: newBatch.expiry || null,
        mfgDate: newBatch.mfg || null,
        mrpPaise: newBatch.mrp ? Math.round(Number(newBatch.mrp) * 100) : null,
      });
      setBatchId(b.id);
      setNewBatch({ no: '', expiry: '', mfg: '', mrp: '' });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    const patch: Partial<DraftLine> = {
      godownId: godownId === defaultGodown ? null : godownId,
      batchId: null,
      serials: [],
    };
    if (mode === 'batch') patch.batchId = batchId;
    if (mode === 'serial') {
      patch.serials = parsed.serials;
      if (serialCount > 0) patch.qtyMicros = BigInt(serialCount) * 1_000_000n;
    }
    onApply(patch);
  };
  const problems =
    mode === 'serial' && check && serialCount > 0
      ? [
          ...check.unavailable.map((s) => t('inventory.details.notInStock', { serial: s })),
          ...check.alreadyIn.map((s) => t('inventory.details.alreadyIn', { serial: s })),
        ]
      : [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" data-testid="stock-details">
        <DialogTitle>{t('inventory.details.title', { item: line.description })}</DialogTitle>
        <DialogDescription>
          {direction === 'out'
            ? t('inventory.details.helpOut')
            : direction === 'in'
              ? t('inventory.details.helpIn')
              : t('inventory.details.helpNone')}
        </DialogDescription>

        <div className="flex flex-col gap-3 text-sm">
          {godowns.length > 1 && (
            <label className="flex flex-col gap-1">
              <span className="text-fg-muted">{t('inventory.details.godown')}</span>
              <Select
                value={effectiveGodown ?? NONE}
                onValueChange={(v) => setGodownId(v === NONE ? null : v)}
              >
                <SelectTrigger
                  data-testid="stock-godown"
                  aria-label={t('inventory.details.godown')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {godowns.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                      {g.id === defaultGodown ? ` (${t('inventory.details.defaultGodown')})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {mode === 'batch' && direction === 'out' && (
            <fieldset className="flex flex-col gap-1">
              <legend className="pb-1 text-fg-muted">{t('inventory.details.batch')}</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="batch"
                  data-testid="stock-batch-fefo"
                  checked={batchId === null}
                  onChange={() => setBatchId(null)}
                />
                {t('inventory.details.fefo')}
              </label>
              {fefoOrder((batches.data ?? []).filter((b) => b.onHandMicros > 0)).map((b) => {
                const expired = isExpired(b.expiryDate, day);
                return (
                  <label
                    key={b.id}
                    className="flex items-center gap-2"
                    data-testid="stock-batch-option"
                  >
                    <input
                      type="radio"
                      name="batch"
                      data-testid={`stock-batch-${b.batchNo}`}
                      checked={batchId === b.id}
                      onChange={() => setBatchId(b.id)}
                    />
                    <span className="font-medium">{b.batchNo}</span>
                    {b.expiryDate && (
                      <span className={expired ? 'text-danger' : 'text-fg-muted'}>
                        {expired
                          ? t('inventory.details.expired', { date: b.expiryDate })
                          : t('inventory.details.expires', { date: b.expiryDate })}
                      </span>
                    )}
                    <span className="ml-auto tabular" data-testid="stock-batch-available">
                      {t('inventory.details.available', { qty: qtyText(b.onHandMicros) })}
                    </span>
                  </label>
                );
              })}
              {batches.data && batches.data.every((b) => b.onHandMicros <= 0) && (
                <p className="text-fg-muted">{t('inventory.details.noBatches')}</p>
              )}
            </fieldset>
          )}

          {mode === 'batch' && direction === 'in' && (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-fg-muted">{t('inventory.details.batch')}</span>
                <Select
                  value={batchId ?? NONE}
                  onValueChange={(v) => setBatchId(v === NONE ? null : v)}
                >
                  <SelectTrigger
                    data-testid="stock-batch-select"
                    aria-label={t('inventory.details.batch')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t('inventory.details.chooseBatch')}</SelectItem>
                    {(batches.data ?? []).map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.batchNo}
                        {b.expiryDate ? ` · ${b.expiryDate}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-2">
                <span className="col-span-2 text-fg-muted">{t('inventory.details.newBatch')}</span>
                <Input
                  placeholder={t('inventory.details.batchNo')}
                  aria-label={t('inventory.details.batchNo')}
                  data-testid="stock-new-batch-no"
                  value={newBatch.no}
                  onChange={(e) => setNewBatch({ ...newBatch, no: e.target.value })}
                />
                <Input
                  type="date"
                  aria-label={t('inventory.details.expiry')}
                  data-testid="stock-new-batch-expiry"
                  value={newBatch.expiry}
                  onChange={(e) => setNewBatch({ ...newBatch, expiry: e.target.value })}
                />
                <Input
                  type="date"
                  aria-label={t('inventory.details.mfg')}
                  data-testid="stock-new-batch-mfg"
                  value={newBatch.mfg}
                  onChange={(e) => setNewBatch({ ...newBatch, mfg: e.target.value })}
                />
                <Input
                  inputMode="decimal"
                  placeholder={t('inventory.details.mrp')}
                  aria-label={t('inventory.details.mrp')}
                  data-testid="stock-new-batch-mrp"
                  value={newBatch.mrp}
                  onChange={(e) => setNewBatch({ ...newBatch, mrp: e.target.value })}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="col-span-2"
                  data-testid="stock-new-batch-add"
                  disabled={busy || newBatch.no.trim() === ''}
                  onClick={() => void addBatch()}
                >
                  {t('inventory.details.addBatch')}
                </Button>
              </div>
            </div>
          )}

          {mode === 'serial' && (
            <label className="flex flex-col gap-1">
              <span className="text-fg-muted">{t('inventory.details.serials')}</span>
              <Textarea
                rows={5}
                data-testid="stock-serials"
                placeholder={t('inventory.details.serialsHelp')}
                value={serialText}
                onChange={(e) => setSerialText(e.target.value)}
              />
              <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <span data-testid="stock-serial-count">
                  {t('inventory.details.serialCount', {
                    count: serialCount,
                    qty: qtyText(Number(line.qtyMicros)),
                  })}
                </span>
                {parsed.duplicates.length > 0 && (
                  <Badge>
                    {t('inventory.details.duplicates', { count: parsed.duplicates.length })}
                  </Badge>
                )}
              </span>
              {problems.length > 0 && (
                <ul className="text-xs text-danger" data-testid="stock-serial-problems">
                  {problems.slice(0, 8).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </label>
          )}

          {mode === 'none' && godowns.length <= 1 && (
            <p className="text-fg-muted">{t('inventory.details.nothingToChoose')}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('inventory.details.cancel')}
            </Button>
            <Button
              type="button"
              data-testid="stock-details-apply"
              disabled={problems.length > 0}
              onClick={apply}
            >
              {t('inventory.details.apply')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import {
  BatchRepo,
  GodownRepo,
  InventoryRepo,
  TransferRepo,
  ValuationRepo,
  type BatchView,
  type Godown,
  type GodownStockRow,
  type ItemStockDetail,
  type LowStockRow,
  type MovementRow,
  type Transfer,
  type ValuationCheck,
  type ValuationSetting,
} from '@gst/db';
import type { DraftDocument, DraftLine, StockPolicy } from '@gst/domain';
import { useCallback } from 'react';

import { useLiveQuery } from '@/app/db';

/** Every table stock is read from, so views refresh when a document or an adjustment is written. */
const TABLES = [
  'stock_movements',
  'documents',
  'items',
  'settings',
  'batches',
  'serials',
  'godowns',
];

export interface ItemStock {
  onHandMicros: number;
  movements: MovementRow[];
}

/** What one item holds and how it got there: the sum of its movements, newest first. */
export function useItemStock(itemId: string | null) {
  return useLiveQuery<ItemStock>({
    tables: TABLES,
    key: ['item-stock', itemId],
    enabled: !!itemId,
    fn: async (d, c) => {
      const repo = new InventoryRepo(d);
      const [onHand, movements] = await Promise.all([
        repo.onHand(c, [itemId!]),
        repo.movementsOf(c, itemId!, 200),
      ]);
      return { onHandMicros: onHand.get(itemId!) ?? 0, movements };
    },
  });
}

/** One item's stock in full: per godown, per batch, serials, and its value (prompt 51). */
export function useItemDetail(itemId: string | null) {
  return useLiveQuery<ItemStockDetail>({
    tables: [...TABLES, 'ledger_entries'],
    key: ['item-detail', itemId],
    enabled: !!itemId,
    fn: (d, c) => new InventoryRepo(d).itemDetail(c, itemId!),
  });
}

/** The business's rule for stock that would go below zero. */
export function useStockPolicy() {
  return useLiveQuery<StockPolicy>({
    tables: ['settings'],
    key: ['stock-policy'],
    fn: (d, c) => new InventoryRepo(d).getPolicy(c),
  });
}

export function useLowStock() {
  return useLiveQuery<LowStockRow[]>({
    tables: TABLES,
    key: ['low-stock'],
    fn: (d, c) => new InventoryRepo(d).lowStock(c),
  });
}

export function useGodowns(includeInactive = false) {
  return useLiveQuery<Godown[]>({
    tables: ['godowns'],
    key: ['godowns', includeInactive],
    fn: (d, c) => new GodownRepo(d).all(c, { includeInactive }),
  });
}

/** Stock per item and godown, with per-godown reorder levels. */
export function useGodownStock() {
  return useLiveQuery<GodownStockRow[]>({
    tables: [...TABLES, 'godown_levels'],
    key: ['godown-stock'],
    fn: (d, c) => new GodownRepo(d).stock(c),
  });
}

export function useBatches(itemId: string | null, godownId: string | null = null) {
  return useLiveQuery<BatchView[]>({
    tables: ['batches', 'stock_movements'],
    key: ['batches', itemId, godownId],
    enabled: !!itemId,
    fn: (d, c) => new BatchRepo(d).of(c, itemId!, { godownId }),
  });
}

export function useTransfers() {
  return useLiveQuery<Transfer[]>({
    tables: ['stock_transfers', 'stock_transfer_lines', 'stock_movements'],
    key: ['transfers'],
    fn: (d, c) => new TransferRepo(d).all(c),
  });
}

export function useValuation() {
  return useLiveQuery<ValuationSetting | null>({
    tables: ['settings'],
    key: ['valuation'],
    fn: (d, c) => new ValuationRepo(d).get(c),
  });
}

export function useValuationCheck() {
  return useLiveQuery<ValuationCheck>({
    tables: [...TABLES, 'ledger_entries'],
    key: ['valuation-check'],
    fn: (d, c) => new ValuationRepo(d).verify(c),
  });
}

export interface StockLabels {
  godowns: Map<string, string>;
  batches: Map<string, string>;
  tracking: Map<string, 'none' | 'batch' | 'serial'>;
}

/** Names for what a document's lines refer to: godowns, batches and each item's tracking mode. */
export function useStockLabels(draft: DraftDocument) {
  const itemIds = [
    ...new Set(draft.lines.map((l) => l.itemId).filter((x): x is string => !!x)),
  ].sort();
  return useLiveQuery<StockLabels>({
    tables: ['godowns', 'batches', 'items'],
    key: ['stock-labels', itemIds.join(',')],
    fn: async (d, c) => {
      const godowns = await new GodownRepo(d).all(c, { includeInactive: true });
      const batches = new Map<string, string>();
      const tracking = new Map<string, 'none' | 'batch' | 'serial'>();
      const itemRows =
        itemIds.length > 0 ? await new (await import('@gst/db')).ItemRepo(d).list(c) : [];
      for (const it of itemRows) {
        if (!itemIds.includes(String(it['id']))) continue;
        tracking.set(
          String(it['id']),
          (String(it['tracking_mode'] ?? 'none') || 'none') as 'none' | 'batch' | 'serial',
        );
        if (it['tracking_mode'] === 'batch')
          for (const b of await new BatchRepo(d).of(c, String(it['id'])))
            batches.set(b.id, b.batchNo);
      }
      return { godowns: new Map(godowns.map((g) => [g.id, g.name])), batches, tracking };
    },
  });
}

/** The short text the grid's stock column shows for a line. */
export function useStockText(labels: StockLabels | undefined, defaultGodownId: string | null) {
  return useCallback(
    (l: DraftLine): string => {
      if (!l.itemId || !labels) return '';
      const parts: string[] = [];
      const mode = labels.tracking.get(l.itemId) ?? 'none';
      if (mode === 'batch') parts.push(l.batchId ? (labels.batches.get(l.batchId) ?? '…') : 'FEFO');
      if (mode === 'serial') parts.push(`${l.serials.length} SN`);
      if (l.godownId && l.godownId !== defaultGodownId)
        parts.push(labels.godowns.get(l.godownId) ?? '…');
      return parts.join(' · ');
    },
    [labels, defaultGodownId],
  );
}

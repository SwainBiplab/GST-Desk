import { InventoryRepo, type LowStockRow, type MovementRow } from '@gst/db';
import type { StockPolicy } from '@gst/domain';

import { useLiveQuery } from '@/app/db';

/** Every table stock is read from, so views refresh when a document or an adjustment is written. */
const TABLES = ['stock_movements', 'documents', 'items', 'settings'];

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

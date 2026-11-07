/**
 * Choose an item on a phone (prompt 43): favourites (sold most) first, search, and the barcode scanner
 * where the device has one; a code that matches nothing, or words that match nothing, can go on the
 * bill as text.
 */
import { ItemRepo, queryRows, type Row } from '@gst/db';
import type { DocumentType } from '@gst/domain';
import { Button, Drawer, DrawerContent, Input, formatPaise, toast } from '@gst/ui';
import { SheetTitle } from '@gst/ui';
import { ScanBarcode } from '@gst/ui/icons';
import { sql } from 'drizzle-orm';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isPurchase } from '../documents/state';

import { favouriteItemIds, matchBarcode } from './logic';

import { useAppDb, useLiveQuery } from '@/app/db';
import { useItemList } from '@/features/items/hooks';
import { barcodeSupported, scanBarcode } from '@/platform/barcode';

export function ItemSheet({
  type,
  onPick,
  onText,
  onClose,
}: {
  type: DocumentType;
  onPick: (item: Row, qtyMicros: bigint) => void;
  onText: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Row[]>([]);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => box.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  const [scanning, setScanning] = useState(false);
  const all = useItemList();
  const favourites = useLiveQuery<Row[]>({
    tables: ['document_lines', 'items'],
    key: ['mobile-favourites'],
    fn: async (d, c) => {
      const counts = (await queryRows(
        d,
        d.db,
        sql`SELECT item_id, count(*) AS count FROM document_lines WHERE business_id = ${c.businessId} AND item_id IS NOT NULL AND deleted_at IS NULL GROUP BY item_id ORDER BY count DESC LIMIT 12`,
      )) as { item_id: string | null; count: number }[];
      const repo = new ItemRepo(d);
      const out: Row[] = [];
      for (const id of favouriteItemIds(
        counts.map((r) => ({ item_id: r.item_id, count: Number(r.count) })),
      )) {
        const it = await repo.get(c, id);
        if (it && it['deleted_at'] == null) out.push(it);
      }
      if (out.length < 8)
        for (const it of await repo.list(c, { orderBy: d.schema.items.name, limit: 20 }))
          if (!out.some((x) => x['id'] === it['id'])) out.push(it);
      return out.slice(0, 12);
    },
  });

  useEffect(() => {
    if (!database || !ctx) return;
    const term = q.trim();
    if (!term) return;
    let live = true;
    const timer = setTimeout(() => {
      void new ItemRepo(database).search(ctx, term, 30).then((r) => live && setResults(r));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, database, ctx]);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await scanBarcode();
      if (!r.ok) {
        if (r.reason === 'unsupported') toast.error(t('mobile.item.scanUnsupported'));
        return;
      }
      const hit = matchBarcode(all.data ?? [], r.code);
      if (hit) onPick(hit, 1_000_000n);
      else {
        setQ(r.code);
        toast.info(t('mobile.item.scanNone', { code: r.code }));
      }
    } finally {
      setScanning(false);
    }
  };

  const price = (it: Row) =>
    formatPaise(Number(isPurchase(type) ? it['purchase_rate_paise'] : it['sale_rate_paise']) || 0);
  const list = q.trim() ? results : (favourites.data ?? []);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="max-h-[85dvh] overflow-auto" data-testid="item-sheet">
        <SheetTitle className="pb-2 text-base font-medium">{t('mobile.item.title')}</SheetTitle>
        <div className="flex gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('mobile.item.search')}
            aria-label={t('mobile.item.search')}
            data-testid="item-sheet-search"
            className="min-h-12"
          />
          {barcodeSupported() && (
            <Button
              variant="outline"
              className="min-h-12 px-3"
              aria-label={t('mobile.item.scan')}
              data-testid="item-sheet-scan"
              disabled={scanning}
              onClick={() => void scan()}
            >
              <ScanBarcode size={20} aria-hidden />
            </Button>
          )}
        </div>
        {!q.trim() && list.length > 0 && (
          <p className="pt-2 text-xs text-fg-muted">{t('mobile.item.favourites')}</p>
        )}
        <ul className="divide-y divide-border">
          {list.map((it) => (
            <li key={String(it['id'])}>
              <button
                type="button"
                className="flex min-h-12 w-full items-center justify-between gap-2 px-1 text-left"
                data-testid="item-sheet-row"
                onClick={() => onPick(it, 1_000_000n)}
              >
                <span className="truncate">{String(it['name'])}</span>
                <span className="tabular text-sm text-fg-muted">{price(it)}</span>
              </button>
            </li>
          ))}
        </ul>
        {q.trim() && list.length === 0 && (
          <Button
            variant="outline"
            className="mt-2 min-h-12 w-full"
            data-testid="item-sheet-text"
            onClick={() => onText(q.trim())}
          >
            {t('mobile.item.asText', { text: q.trim() })}
          </Button>
        )}
      </DrawerContent>
    </Drawer>
  );
}

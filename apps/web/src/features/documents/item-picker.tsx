import { ItemRepo, type Row } from '@gst/db';
import { parseQtyMicros } from '@gst/domain';
import { Dialog, DialogContent, DialogDescription, DialogTitle, Input, MoneyText } from '@gst/ui';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppDb } from '@/app/db';

/**
 * Pick an item for a grid row. Opens on Enter in the item cell; type to search by name, SKU, barcode
 * or HSN, arrows and Enter to choose. When the typed name matches nothing it offers to create it.
 */
export function ItemPicker({
  initialQuery,
  initialQty,
  price,
  onPick,
  onCreate,
  onText,
  onClose,
}: {
  initialQuery: string;
  /** Quantity to start with, as text. */
  initialQty: string;
  /** Which price to show beside each item. */
  price: 'sale' | 'purchase';
  /** The chosen item and the quantity typed beside it, in micro-units. */
  onPick: (item: Row, qtyMicros: bigint) => void;
  onCreate: (name: string) => void;
  /** Use the typed words as the line's text, without an item behind it. */
  onText: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<Row[]>([]);
  const [active, setActive] = useState(0);
  const q = query.trim();

  // The grid re-focuses its canvas just after the Enter that opened this picker. For a moment after
  // opening, any focus that lands outside the dialog goes straight back to the search box.
  useEffect(() => {
    const until = performance.now() + 400;
    const back = (e: FocusEvent) => {
      if (
        performance.now() < until &&
        !(e.target as HTMLElement).closest('[data-testid=item-picker]')
      )
        input.current?.focus();
    };
    document.addEventListener('focusin', back);
    return () => document.removeEventListener('focusin', back);
  }, []);
  // the search the shown results belong to. Enter before it catches up with the typing waits for it
  // instead of choosing a stale row.
  const [settled, setSettled] = useState<string | null>(null);
  const waiting = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const [qtyText, setQtyText] = useState(initialQty);
  const qty = parseQtyMicros(qtyText);
  const qtyOk = typeof qty === 'number' && qty > 0;
  // the search below finishes later than the typing; it must use the quantity as it is by then
  const latestQty = useRef<number | null | undefined>(qty);
  useEffect(() => {
    latestQty.current = qty;
  });
  // when this picker appeared: the Enter that opened it can arrive at the search box too, and is not a choice
  const openedAt = useRef(0);
  const typedYet = useRef(false);
  useEffect(() => {
    openedAt.current = performance.now();
  }, []);

  useEffect(() => {
    if (!database || !ctx) return;
    let live = true;
    const timer = setTimeout(
      () => {
        const repo = new ItemRepo(database);
        const found = q
          ? repo.search(ctx, q, 12)
          : repo.list(ctx, { orderBy: database.schema.items.name, limit: 12 });
        void found.then((all) => {
          if (!live) return;
          const rows = all.filter((r) => r['is_active'] !== false);
          setResults(rows);
          setActive(0);
          setSettled(q);
          if (waiting.current) {
            waiting.current = false;
            const q2 = latestQty.current;
            if (rows[0] && typeof q2 === 'number' && q2 > 0) onPick(rows[0], BigInt(q2));
            else if (q) onCreate(q);
          }
        });
      },
      q ? 100 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `onPick` and `onCreate` only run once, from the result of this very search
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, database, ctx]);

  const exact = results.some((r) => String(r['name']).toLowerCase() === q.toLowerCase());
  const canCreate = q !== '' && !exact;
  const rows = results.length + (canCreate ? 2 : 0);

  const choose = (i: number) => {
    if (!qtyOk) return;
    if (i < results.length) onPick(results[i]!, BigInt(qty));
    else if (canCreate) (i === results.length ? onCreate : onText)(q);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!typedYet.current && performance.now() - openedAt.current < 250) return;
      if (settled !== q) waiting.current = true;
      else if (rows > 0) choose(active);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="w-[min(34rem,calc(100vw-2rem))] gap-2"
        data-testid="item-picker"
        // the editor puts the cursor on the quantity itself; the dialog must not take focus back
        onOpenAutoFocus={(e) => {
          // the search box takes the keyboard at once, so nothing typed next goes to the grid behind
          e.preventDefault();
          input.current?.focus();
        }}
        // the grid takes focus back for a moment after the Enter that opened this; that must not close it
        onFocusOutside={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DialogTitle className="text-lg font-semibold">{t('docs.items.pick')}</DialogTitle>
        <DialogDescription className="text-fg-muted">{t('docs.items.pickHelp')}</DialogDescription>
        <Input
          ref={input}
          aria-label={t('docs.items.search')}
          placeholder={t('docs.items.search')}
          data-testid="item-picker-input"
          value={query}
          onChange={(e) => {
            typedYet.current = true;
            setQuery(e.target.value);
          }}
          onKeyDown={onKey}
        />
        <ul
          role="listbox"
          tabIndex={-1}
          aria-label={t('docs.items.results')}
          className="flex max-h-72 flex-col overflow-auto"
        >
          {results.map((r, i) => (
            <li key={r['id']} role="option" aria-selected={i === active}>
              <button
                type="button"
                tabIndex={-1}
                data-testid="item-result"
                className={`flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left ${i === active ? 'bg-surface-2' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{r['name']}</span>
                  <span className="block truncate text-xs text-fg-muted">
                    {[r['sku'], r['hsn'], r['barcode']].filter(Boolean).join(' | ') ||
                      t('docs.header.noDetails')}
                  </span>
                </span>
                <MoneyText
                  paise={BigInt(
                    Number(
                      price === 'purchase' ? r['purchase_rate_paise'] : r['sale_rate_paise'],
                    ) || 0,
                  )}
                />
              </button>
            </li>
          ))}
          {canCreate && (
            <>
              <li role="option" aria-selected={active === results.length}>
                <button
                  type="button"
                  tabIndex={-1}
                  data-testid="item-create"
                  className={`w-full rounded-sm px-2 py-1.5 text-left text-sm ${active === results.length ? 'bg-surface-2' : ''}`}
                  onMouseEnter={() => setActive(results.length)}
                  onClick={() => onCreate(q)}
                >
                  {t('docs.items.create', { name: q })}
                </button>
              </li>
              <li role="option" aria-selected={active === results.length + 1}>
                <button
                  type="button"
                  tabIndex={-1}
                  data-testid="item-as-text"
                  className={`w-full rounded-sm px-2 py-1.5 text-left text-sm ${active === results.length + 1 ? 'bg-surface-2' : ''}`}
                  onMouseEnter={() => setActive(results.length + 1)}
                  onClick={() => onText(q)}
                >
                  {t('docs.items.asText', { name: q })}
                </button>
              </li>
            </>
          )}
          {rows === 0 && (
            <li className="px-2 py-3 text-sm text-fg-muted">{t('docs.items.none')}</li>
          )}
        </ul>
        <label className="flex items-center gap-2 text-sm" htmlFor="picker-qty">
          {t('docs.items.qty')}
          <Input
            id="picker-qty"
            className="w-28 text-right"
            inputMode="decimal"
            data-testid="item-picker-qty"
            aria-invalid={!qtyOk}
            value={qtyText}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setQtyText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!qtyOk) return;
                // same rule as the search box: never choose from results older than what was typed
                if (settled !== q) waiting.current = true;
                else choose(active);
              }
            }}
          />
          {!qtyOk && (
            <span role="alert" className="text-xs text-danger">
              {t('docs.grid.bad.qty')}
            </span>
          )}
        </label>
      </DialogContent>
    </Dialog>
  );
}

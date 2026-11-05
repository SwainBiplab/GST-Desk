import type { Row } from '@gst/db';
import { isLow } from '@gst/domain';
import { Badge, Button, MoneyText } from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { useItemStock } from './hooks';

import { useAppNavigate } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { editorPath } from '@/features/documents/editor-page';
import { qtyText } from '@/features/reports/model';

/**
 * An item's stock: what it holds now, its reorder level, the value at purchase price, and every
 * movement with a link to the document it came from. Adjusting goes to the adjustment screen.
 */
export function StockPanel({ item, shell }: { item: Row; shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const stock = useItemStock(String(item['id']));
  if (!item['track_stock']) return null;
  const loaded = !!stock.data;
  const onHand = stock.data?.onHandMicros ?? 0;
  const min = Number(item['min_stock_micros'] ?? 0);
  const rate = Number(item['purchase_rate_paise'] ?? 0);
  // quantity (millionths) times price (paise), in whole paise
  const value = Number(
    (BigInt(onHand) * BigInt(rate) + (onHand < 0 ? -500_000n : 500_000n)) / 1_000_000n,
  );
  const low = isLow(onHand, min);

  return (
    <section
      className="mt-4 border-t border-border pt-3"
      data-testid="stock-panel"
      aria-label={t('inventory.panel.title')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{t('inventory.panel.title')}</h3>
        <Button
          type="button"
          variant="outline"
          data-testid="stock-adjust"
          onClick={() => navigate(`/${shell}/items`, { adjust: '1', item: String(item['id']) })}
        >
          {t('inventory.panel.adjust')}
        </Button>
      </div>
      <dl className="grid grid-cols-3 gap-3 py-2 text-sm">
        <div>
          <dt className="text-fg-muted">{t('inventory.panel.onHand')}</dt>
          <dd className="text-lg font-semibold">
            <span data-testid="stock-on-hand">{loaded ? qtyText(onHand) : '…'}</span>
            {loaded && low && (
              <Badge className="ml-2 align-middle" data-testid="stock-low">
                {t('inventory.panel.low')}
              </Badge>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted">{t('inventory.panel.reorder')}</dt>
          <dd data-testid="stock-reorder">
            {min > 0 ? qtyText(min) : t('inventory.panel.noLevel')}
          </dd>
        </div>
        <div>
          <dt className="text-fg-muted">{t('inventory.panel.value')}</dt>
          <dd data-testid="stock-value">{loaded ? <MoneyText paise={value} /> : '…'}</dd>
        </div>
      </dl>
      {stock.data && stock.data.movements.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('inventory.panel.noMovements')}</p>
      ) : (
        <div className="max-h-72 overflow-auto rounded-md border border-border">
          <table className="w-full text-sm" data-testid="stock-movements">
            <thead className="sticky top-0 bg-surface-1 text-left text-xs uppercase text-fg-muted">
              <tr>
                <th className="p-2 font-medium">{t('inventory.panel.date')}</th>
                <th className="p-2 font-medium">{t('inventory.panel.what')}</th>
                <th className="p-2 text-right font-medium">{t('inventory.panel.qty')}</th>
              </tr>
            </thead>
            <tbody>
              {(stock.data?.movements ?? []).map((m) => (
                <tr key={m.id} className="border-t border-border" data-testid="stock-movement">
                  <td className="tabular p-2">{m.date}</td>
                  <td className="p-2">
                    {m.documentId && m.documentType ? (
                      <button
                        type="button"
                        className="underline-offset-2 hover:underline"
                        data-testid="stock-doc-link"
                        onClick={() =>
                          navigate(editorPath(shell), { type: m.documentType, id: m.documentId })
                        }
                      >
                        {t(`docs.types.${m.documentType}`, { defaultValue: m.documentType })}{' '}
                        {m.documentNumber ?? ''}
                      </button>
                    ) : (
                      <span>{m.note || t(`inventory.kind.${m.kind}`)}</span>
                    )}
                  </td>
                  <td
                    className={`tabular p-2 text-right ${m.qtyMicros < 0 ? 'text-danger' : ''}`}
                    data-testid="stock-qty"
                  >
                    {m.qtyMicros > 0 ? '+' : ''}
                    {qtyText(m.qtyMicros)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

import type { Row } from '@gst/db';
import { isExpired, isLow, today } from '@gst/domain';
import { Badge, Button, MoneyText } from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { useItemDetail, useItemStock } from './hooks';

import { useAppNavigate } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { editorPath } from '@/features/documents/editor-page';
import { qtyText } from '@/features/reports/model';
import { dyn } from '@/lib/dyn-key';

/**
 * An item's stock: what it holds now (per godown and per batch when it is tracked that way), its
 * reorder level, the value under the business's method, and every movement with a link to the
 * document it came from. Adjusting goes to the adjustment screen.
 */
export function StockPanel({ item, shell }: { item: Row; shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const itemId = String(item['id']);
  const stock = useItemStock(itemId);
  const detail = useItemDetail(itemId);
  if (!item['track_stock']) return null;
  const loaded = !!stock.data;
  const onHand = stock.data?.onHandMicros ?? 0;
  const min = Number(item['min_stock_micros'] ?? 0);
  const low = isLow(onHand, min);
  const day = today(() => new Date());
  const d = detail.data;
  const mode = d?.trackingMode ?? 'none';

  return (
    <section
      className="mt-4 border-t border-border pt-3"
      data-testid="stock-panel"
      aria-label={t('inventory.panel.title')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{t('inventory.panel.title')}</h3>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            data-testid="stock-page-link"
            onClick={() => navigate(`/${shell}/stock`, { item: itemId })}
          >
            {t('inventory.panel.openStock')}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="stock-adjust"
            onClick={() => navigate(`/${shell}/items`, { adjust: '1', item: itemId })}
          >
            {t('inventory.panel.adjust')}
          </Button>
        </div>
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
          <dt className="text-fg-muted">
            {d?.method ? t(dyn(`inventory.panel.valueAt.${d.method}`)) : t('inventory.panel.value')}
          </dt>
          <dd data-testid="stock-value">{d ? <MoneyText paise={Number(d.valuePaise)} /> : '…'}</dd>
        </div>
      </dl>

      {d && d.byGodown.length > 1 && (
        <table className="mb-2 w-full text-sm" data-testid="stock-by-godown">
          <thead className="text-left text-xs uppercase text-fg-muted">
            <tr>
              <th className="p-1 font-medium">{t('inventory.panel.godown')}</th>
              <th className="p-1 text-right font-medium">{t('inventory.panel.qty')}</th>
            </tr>
          </thead>
          <tbody>
            {d.byGodown.map((g) => (
              <tr
                key={g.godown.id}
                className="border-t border-border"
                data-testid="stock-godown-row"
              >
                <td className="p-1">{g.godown.name}</td>
                <td className="tabular p-1 text-right" data-testid="stock-godown-qty">
                  {qtyText(g.onHandMicros)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {d && mode === 'batch' && (
        <table className="mb-2 w-full text-sm" data-testid="stock-batches">
          <thead className="text-left text-xs uppercase text-fg-muted">
            <tr>
              <th className="p-1 font-medium">{t('inventory.panel.batch')}</th>
              <th className="p-1 font-medium">{t('inventory.panel.expiry')}</th>
              <th className="p-1 text-right font-medium">{t('inventory.panel.qty')}</th>
            </tr>
          </thead>
          <tbody>
            {d.batches
              .filter((b) => b.onHandMicros !== 0)
              .map((b) => (
                <tr key={b.id} className="border-t border-border" data-testid="stock-batch-row">
                  <td className="p-1">{b.batchNo}</td>
                  <td className="p-1">
                    {b.expiryDate ?? '—'}
                    {b.expiryDate && isExpired(b.expiryDate, day) && (
                      <Badge className="ml-1" data-testid="stock-batch-expired">
                        {t('inventory.panel.expired')}
                      </Badge>
                    )}
                  </td>
                  <td className="tabular p-1 text-right" data-testid="stock-batch-qty">
                    {qtyText(b.onHandMicros)}
                  </td>
                </tr>
              ))}
            {d.batches.every((b) => b.onHandMicros === 0) && (
              <tr>
                <td className="p-1 text-fg-muted" colSpan={3}>
                  {t('inventory.panel.noBatchStock')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {d && mode === 'serial' && (
        <p className="pb-2 text-sm" data-testid="stock-serials">
          {t('inventory.panel.serialsInStock', { count: d.serialsInStock })}
        </p>
      )}

      {stock.data && stock.data.movements.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('inventory.panel.noMovements')}</p>
      ) : (
        <div className="max-h-72 overflow-auto rounded-md border border-border">
          <table className="w-full text-sm" data-testid="stock-movements">
            <thead className="sticky top-0 bg-surface-1 text-left text-xs uppercase text-fg-muted">
              <tr>
                <th className="p-2 font-medium">{t('inventory.panel.date')}</th>
                <th className="p-2 font-medium">{t('inventory.panel.what')}</th>
                <th className="p-2 font-medium">{t('inventory.panel.where')}</th>
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
                      <span>{m.note || t(dyn(`inventory.kind.${m.kind}`))}</span>
                    )}
                  </td>
                  <td className="p-2 text-xs text-fg-muted" data-testid="stock-where">
                    {[m.godownName, m.batchNo, m.serials.length > 0 ? `${m.serials.length} SN` : '']
                      .filter(Boolean)
                      .join(' · ')}
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

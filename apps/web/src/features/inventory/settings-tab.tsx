import { InventoryRepo } from '@gst/db';
import type { StockPolicy } from '@gst/domain';
import { toast } from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { useStockPolicy } from './hooks';

import { useAppDb } from '@/app/db';

/** Inventory settings: what happens when a document would take an item's stock below zero. */
export function InventoryTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const policy = useStockPolicy();
  const current: StockPolicy = policy.data ?? 'allow';

  const choose = async (next: StockPolicy) => {
    // until the saved policy has been read, "unchanged" cannot be told from a real change
    if (!database || !ctx || !policy.isSuccess || next === current) return;
    try {
      await new InventoryRepo(database).setPolicy(ctx, next);
      toast.success(t('inventory.policy.saved'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div data-testid="section-inventory" className="max-w-xl">
      <fieldset className="flex flex-col gap-3">
        <legend className="pb-1 text-base font-semibold">{t('inventory.policy.title')}</legend>
        <p className="text-sm text-fg-muted">{t('inventory.policy.help')}</p>
        {(['allow', 'block'] as const).map((p) => (
          <div key={p} className="flex items-start gap-2 text-sm">
            <input
              id={`stock-policy-${p}`}
              type="radio"
              name="stock-policy"
              className="mt-1"
              data-testid={`stock-policy-${p}`}
              aria-describedby={`stock-policy-${p}-help`}
              checked={current === p}
              disabled={!policy.isSuccess}
              onChange={() => void choose(p)}
            />
            <div>
              <label htmlFor={`stock-policy-${p}`} className="block font-medium">
                {t(`inventory.policy.${p}`)}
              </label>
              <p id={`stock-policy-${p}-help`} className="text-fg-muted">
                {t(`inventory.policy.${p}Help`)}
              </p>
            </div>
          </div>
        ))}
      </fieldset>
    </div>
  );
}

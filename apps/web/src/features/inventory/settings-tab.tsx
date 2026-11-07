import { InventoryRepo, ValuationRepo } from '@gst/db';
import { today, type StockPolicy, type ValuationMethod } from '@gst/domain';
import { Button, MoneyText, toast } from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useStockPolicy, useValuation, useValuationCheck } from './hooks';

import { useConfirm } from '@/app/components/confirm';
import { useAppDb } from '@/app/db';

/**
 * Inventory settings: what happens when a document would take an item's stock below zero, and how
 * stock is valued (prompt 51): at purchase price with nothing in the books, or FIFO or weighted
 * average with every movement posted to the Inventory ledger.
 */
export function InventoryTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const confirm = useConfirm();
  const policy = useStockPolicy();
  const current: StockPolicy = policy.data ?? 'allow';
  const valuation = useValuation();
  const check = useValuationCheck();
  const [busy, setBusy] = useState(false);
  const method = valuation.data?.method ?? null;

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

  const chooseMethod = async (next: ValuationMethod) => {
    if (!database || !ctx || !valuation.isSuccess || next === method) return;
    const repo = new ValuationRepo(database);
    setBusy(true);
    try {
      const locked = method ? await repo.locked(ctx) : false;
      if (locked) {
        const go = await confirm({
          title: t('inventory.valuation.migrateTitle'),
          description: t('inventory.valuation.migrateHelp', {
            method: t(`inventory.valuation.${next}`),
          }),
          confirmLabel: t('inventory.valuation.migrate'),
        });
        if (!go) return;
      }
      const r = await repo.set(ctx, next, { today: today(() => new Date()), migrate: locked });
      toast.success(
        r.voucherId ? t('inventory.valuation.savedPosted') : t('inventory.valuation.saved'),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const trueUp = async () => {
    if (!database || !ctx) return;
    setBusy(true);
    try {
      const id = await new ValuationRepo(database).trueUp(
        ctx,
        today(() => new Date()),
      );
      toast.success(id ? t('inventory.valuation.truedUp') : t('inventory.valuation.nothingToDo'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="section-inventory" className="flex max-w-xl flex-col gap-6">
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

      <fieldset className="flex flex-col gap-3" data-testid="valuation-settings">
        <legend className="pb-1 text-base font-semibold">{t('inventory.valuation.title')}</legend>
        <p className="text-sm text-fg-muted">{t('inventory.valuation.help')}</p>
        {(['fifo', 'wavg'] as const).map((m) => (
          <div key={m} className="flex items-start gap-2 text-sm">
            <input
              id={`valuation-${m}`}
              type="radio"
              name="valuation"
              className="mt-1"
              data-testid={`valuation-${m}`}
              checked={method === m}
              disabled={!valuation.isSuccess || busy}
              onChange={() => void chooseMethod(m)}
            />
            <div>
              <label htmlFor={`valuation-${m}`} className="block font-medium">
                {t(`inventory.valuation.${m}`)}
              </label>
              <p className="text-fg-muted">{t(`inventory.valuation.${m}Help`)}</p>
            </div>
          </div>
        ))}
        {method === null && valuation.isSuccess && (
          <p className="text-sm" data-testid="valuation-none">
            {t('inventory.valuation.none')}
          </p>
        )}
        {check.data && method && (
          <dl
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-border p-3 text-sm"
            data-testid="valuation-check"
            data-ties={check.data.differencePaise === 0n ? 'yes' : 'no'}
          >
            <dt className="text-fg-muted">{t('inventory.valuation.stockValue')}</dt>
            <dd className="tabular text-right">
              <MoneyText paise={Number(check.data.stockValuePaise)} />
            </dd>
            <dt className="text-fg-muted">{t('inventory.valuation.ledger')}</dt>
            <dd className="tabular text-right">
              <MoneyText paise={Number(check.data.ledgerPaise)} />
            </dd>
            <dt className="text-fg-muted">{t('inventory.valuation.difference')}</dt>
            <dd className="tabular text-right" data-testid="valuation-difference">
              {check.data.differencePaise === 0n ? (
                t('inventory.valuation.ties')
              ) : (
                <MoneyText paise={Number(check.data.differencePaise)} />
              )}
            </dd>
            {check.data.differencePaise !== 0n && (
              <dd className="col-span-2 text-right">
                <Button
                  type="button"
                  variant="outline"
                  data-testid="valuation-trueup"
                  disabled={busy}
                  onClick={() => void trueUp()}
                >
                  {t('inventory.valuation.trueUp')}
                </Button>
              </dd>
            )}
          </dl>
        )}
      </fieldset>
    </div>
  );
}

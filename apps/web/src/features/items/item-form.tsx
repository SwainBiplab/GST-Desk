import { GST_RATES_BP, itemWarnings, type ItemWarningCode } from '@gst/domain';
import {
  Button,
  Checkbox,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@gst/ui';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  emptyItemDraft,
  parseDraft,
  trimZeros,
  validateItem,
  type Errors,
  type ItemDraft,
} from './form';
import { useHsnEntry, useUnits } from './hooks';
import { HsnField } from './hsn-field';
import { ItemImages } from './item-images';

import { useUnsavedGuard } from '@/app/unsaved';
import { TranslitInput } from '@/features/i18n/translit-input';
import { Field } from '@/features/onboarding/field';

const NONE = '-';
const rateText = (bp: number) => trimZeros((bp / 100).toFixed(2));

/**
 * Create or edit one item. GST rate and cess fill in from the HSN master; changing the rate away
 * from the master is allowed and flagged. Opening stock is set only when the item is created.
 */
export function ItemForm({
  initial,
  isEdit = false,
  submitLabel,
  busy = false,
  serverErrors,
  onSubmit,
  onCancel,
}: {
  initial?: ItemDraft;
  isEdit?: boolean;
  submitLabel?: string;
  busy?: boolean;
  /** Problems the server found (for example a SKU already in use), keyed by form field. */
  serverErrors?: Errors | undefined;
  onSubmit: (draft: ItemDraft) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [start] = useState(() => initial ?? emptyItemDraft());
  const [draft, setDraft] = useState<ItemDraft>(start);
  const [errors, setErrors] = useState<Errors>({});
  const dirty = JSON.stringify(draft) !== JSON.stringify(start);
  useUnsavedGuard(dirty && !busy);
  const units = useUnits().data ?? [];
  const master = useHsnEntry(draft.hsn).data ?? null;
  const shown: Errors = { ...serverErrors, ...errors };

  const change = (patch: Partial<ItemDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
  };

  const service = draft.kind === 'service';
  const warnings: ItemWarningCode[] = itemWarnings(
    parseDraft(draft).fields,
    master?.rate_bp ?? null,
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = validateItem(draft);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    void onSubmit(draft);
  };

  const unitSelect = (
    field: 'unitId' | 'secondaryUnitId',
    label: string,
    testId: string,
    exclude?: string,
  ) => (
    <Field label={label} error={shown[field]}>
      {(c) => (
        <Select
          value={draft[field] || NONE}
          onValueChange={(v) => change({ [field]: v === NONE ? '' : v })}
        >
          <SelectTrigger {...c} data-testid={testId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t('items.form.noUnit')}</SelectItem>
            {units
              .filter((u) => u['id'] !== exclude)
              .map((u) => (
                <SelectItem key={u['id']} value={u['id']}>
                  {u['code']} · {u['name']}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  );

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5" data-testid="item-form">
      <fieldset className="flex flex-col gap-1">
        <legend className="pb-1 text-sm font-medium">{t('items.form.kind')}</legend>
        <RadioGroup
          value={draft.kind}
          onValueChange={(kind) =>
            change({
              kind: kind as ItemDraft['kind'],
              ...(kind === 'service' ? { trackStock: false } : {}),
            })
          }
          className="flex gap-4"
          aria-label={t('items.form.kind')}
        >
          {(['goods', 'service'] as const).map((k) => (
            <label key={k} htmlFor={`kind-${k}`} className="flex items-center gap-2">
              <RadioGroupItem id={`kind-${k}`} value={k} data-testid={`item-kind-${k}`} />
              {t(`items.kinds.${k}`)}
            </label>
          ))}
        </RadioGroup>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('items.form.name')} error={shown['name']} className="sm:col-span-2">
          {(c) => (
            <TranslitInput
              {...c}
              data-autofocus
              data-testid="item-name"
              value={draft.name}
              onValueChange={(name, nameLatin) => change({ name, nameLatin })}
            />
          )}
        </Field>
        <Field label={t('items.form.sku')} error={shown['sku']}>
          {(c) => (
            <Input
              {...c}
              data-testid="item-sku"
              value={draft.sku}
              onChange={(e) => change({ sku: e.target.value })}
            />
          )}
        </Field>
        <Field
          label={t('items.form.barcode')}
          error={shown['barcode']}
          hint={t('items.form.barcodeHelp')}
        >
          {(c) => (
            <Input
              {...c}
              inputMode="numeric"
              autoComplete="off"
              data-testid="item-barcode"
              value={draft.barcode}
              onChange={(e) => change({ barcode: e.target.value })}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <HsnField
            value={draft.hsn}
            itemName={draft.name}
            error={shown['hsn']}
            onChange={(hsn) => change({ hsn })}
            onPick={(h) =>
              change({
                hsn: h.code,
                gstRate: rateText(h.rateBp),
                cess: h.cessBp ? rateText(h.cessBp) : '',
              })
            }
          />
        </div>

        <Field label={t('items.form.gstRate')} error={shown['gstRate']}>
          {(c) => (
            <Select
              value={draft.gstRate === '' ? NONE : draft.gstRate}
              onValueChange={(v) => change({ gstRate: v === NONE ? '' : v })}
            >
              <SelectTrigger {...c} data-testid="item-gst">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('items.form.rateNotSet')}</SelectItem>
                {GST_RATES_BP.map((bp) => (
                  <SelectItem key={bp} value={rateText(bp)}>
                    {rateText(bp)}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label={t('items.form.cess')} error={shown['cess']}>
          {(c) => (
            <Input
              {...c}
              inputMode="decimal"
              data-testid="item-cess"
              value={draft.cess}
              onChange={(e) => change({ cess: e.target.value })}
            />
          )}
        </Field>
        {warnings.includes('gst_overridden') && master && (
          <p
            role="status"
            data-testid="rate-override-warning"
            className="flex flex-wrap items-center gap-2 rounded-md border border-warning p-2 text-sm sm:col-span-2"
          >
            {t('items.warn.gst_overridden', {
              master: rateText(master.rate_bp),
              code: master.code,
            })}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                change({
                  gstRate: rateText(master.rate_bp),
                  cess: master.cess_bp ? rateText(master.cess_bp) : '',
                })
              }
            >
              {t('items.form.useMasterRate')}
            </Button>
          </p>
        )}

        <Field label={t('items.form.salePrice')} error={shown['salePrice']}>
          {(c) => (
            <Input
              {...c}
              inputMode="decimal"
              data-testid="item-sale"
              value={draft.salePrice}
              onChange={(e) => change({ salePrice: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('items.form.purchasePrice')} error={shown['purchasePrice']}>
          {(c) => (
            <Input
              {...c}
              inputMode="decimal"
              data-testid="item-purchase"
              value={draft.purchasePrice}
              onChange={(e) => change({ purchasePrice: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('items.form.mrp')} error={shown['mrp']}>
          {(c) => (
            <Input
              {...c}
              inputMode="decimal"
              data-testid="item-mrp"
              value={draft.mrp}
              onChange={(e) => change({ mrp: e.target.value })}
            />
          )}
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm" htmlFor="item-inclusive">
          <Checkbox
            id="item-inclusive"
            data-testid="item-inclusive"
            checked={draft.taxInclusive}
            onCheckedChange={(v) => change({ taxInclusive: v === true })}
          />
          {t('items.form.taxInclusive')}
        </label>
        {warnings
          .filter((w) => w === 'sale_above_mrp' || w === 'sale_below_purchase')
          .map((w) => (
            <p key={w} role="status" className="text-sm text-warning sm:col-span-2">
              {t(`items.warn.${w}`)}
            </p>
          ))}

        {unitSelect('unitId', t('items.form.unit'), 'item-unit')}
        <div />
        {unitSelect('secondaryUnitId', t('items.form.secondaryUnit'), 'item-unit2', draft.unitId)}
        {draft.secondaryUnitId && (
          <Field
            label={t('items.form.factor')}
            error={shown['secondaryFactor']}
            hint={t('items.form.factorHelp')}
          >
            {(c) => (
              <Input
                {...c}
                inputMode="decimal"
                data-testid="item-factor"
                value={draft.secondaryFactor}
                onChange={(e) => change({ secondaryFactor: e.target.value })}
              />
            )}
          </Field>
        )}
      </div>

      {!service && (
        <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('items.form.stock')}</legend>
          <label className="flex items-center gap-2 text-sm" htmlFor="item-track">
            <Checkbox
              id="item-track"
              data-testid="item-track"
              checked={draft.trackStock}
              onCheckedChange={(v) => change({ trackStock: v === true })}
            />
            {t('items.form.trackStock')}
          </label>
          {draft.trackStock && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label={t('items.form.openingQty')}
                error={shown['openingQty']}
                hint={isEdit ? t('items.form.openingLocked') : undefined}
              >
                {(c) => (
                  <Input
                    {...c}
                    inputMode="decimal"
                    data-testid="item-opening-qty"
                    disabled={isEdit}
                    value={draft.openingQty}
                    onChange={(e) => change({ openingQty: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('items.form.openingValue')} error={shown['openingValue']}>
                {(c) => (
                  <Input
                    {...c}
                    inputMode="decimal"
                    data-testid="item-opening-value"
                    disabled={isEdit}
                    value={draft.openingValue}
                    onChange={(e) => change({ openingValue: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('items.form.reorder')} error={shown['reorder']}>
                {(c) => (
                  <Input
                    {...c}
                    inputMode="decimal"
                    data-testid="item-reorder"
                    value={draft.reorder}
                    onChange={(e) => change({ reorder: e.target.value })}
                  />
                )}
              </Field>
            </div>
          )}
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('items.form.tags')}
          hint={t('items.form.tagsHelp')}
          className="sm:col-span-2"
        >
          {(c) => (
            <Input
              {...c}
              data-testid="item-tags"
              value={draft.tags}
              onChange={(e) => change({ tags: e.target.value })}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <ItemImages value={draft.images} onChange={(images) => change({ images })} />
        </div>
        <Field label={t('items.form.description')} className="sm:col-span-2">
          {(c) => (
            <Textarea
              {...c}
              rows={2}
              value={draft.description}
              onChange={(e) => change({ description: e.target.value })}
            />
          )}
        </Field>
        <label className="flex items-center gap-2 text-sm" htmlFor="item-active">
          <Switch
            id="item-active"
            data-testid="item-active"
            checked={draft.isActive}
            onCheckedChange={(v) => change({ isActive: v })}
          />
          {t('items.form.active')}
        </label>
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} data-testid="item-cancel">
            {t('items.form.cancel')}
          </Button>
        )}
        <Button type="submit" disabled={busy} data-testid="item-save">
          {submitLabel ?? t('items.form.save')}
        </Button>
      </div>
    </form>
  );
}

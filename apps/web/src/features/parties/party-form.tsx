import { STATES, entityType } from '@gst/domain';
import { PRINT_LANGUAGES, PRINT_LANGUAGE_NAMES } from '@gst/i18n';
import {
  Button,
  Checkbox,
  DatePicker,
  GstinInput,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@gst/ui';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  deriveParty,
  emptyPartyDraft,
  isExport,
  validateParty,
  type AddressDraft,
  type Errors,
  type FormMode,
  type PartyDraft,
} from './form';

import { useUnsavedGuard } from '@/app/unsaved';
import { TranslitInput } from '@/features/i18n/translit-input';
import { Field } from '@/features/onboarding/field';

const STATE_OPTIONS = Object.entries(STATES).filter(([code]) => code !== '97' && code !== '99');

const isoToDate = (iso: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const dateToIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function AddressFields({
  prefix,
  value,
  onChange,
  errors,
}: {
  prefix: 'billing' | 'shipping';
  value: AddressDraft;
  onChange: (a: AddressDraft) => void;
  errors: Errors;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label={t('parties.form.line1')} className="sm:col-span-3">
        {(c) => (
          <Input
            {...c}
            data-testid={`${prefix}-line1`}
            value={value.line1}
            onChange={(e) => onChange({ ...value, line1: e.target.value })}
          />
        )}
      </Field>
      <Field label={t('parties.form.city')}>
        {(c) => (
          <Input
            {...c}
            data-testid={`${prefix}-city`}
            value={value.city}
            onChange={(e) => onChange({ ...value, city: e.target.value })}
          />
        )}
      </Field>
      <Field label={t('parties.form.pincode')} error={errors[`${prefix}Pincode`]}>
        {(c) => (
          <Input
            {...c}
            inputMode="numeric"
            value={value.pincode}
            onChange={(e) => onChange({ ...value, pincode: e.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

/**
 * Create or edit a party. `quick` is the short form for use inside the invoice grid (name, GSTIN or state,
 * phone); `full` adds addresses, contacts, credit terms, opening balance, notes and tags.
 */
export function PartyForm({
  mode = 'full',
  initial,
  submitLabel,
  busy = false,
  onSubmit,
  onCancel,
}: {
  mode?: FormMode;
  initial?: PartyDraft;
  submitLabel?: string;
  busy?: boolean;
  onSubmit: (draft: PartyDraft) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [start] = useState(() => initial ?? emptyPartyDraft());
  const [draft, setDraft] = useState<PartyDraft>(start);
  const [errors, setErrors] = useState<Errors>({});
  const dirty = JSON.stringify(draft) !== JSON.stringify(start);
  useUnsavedGuard(dirty && !busy);

  const change = (patch: Partial<PartyDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
  };
  const derived = deriveParty(draft);
  const exporting = isExport(draft);
  const full = mode === 'full';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = validateParty(draft, mode);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    void onSubmit(draft);
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-5"
      data-testid={`party-form-${mode}`}
    >
      {full && (
        <fieldset className="flex flex-col gap-1">
          <legend className="pb-1 text-sm font-medium">{t('parties.form.type')}</legend>
          <RadioGroup
            value={draft.type}
            onValueChange={(type) => change({ type: type as PartyDraft['type'] })}
            className="flex gap-4"
            aria-label={t('parties.form.type')}
          >
            {(['customer', 'supplier', 'both'] as const).map((k) => (
              <label key={k} htmlFor={`type-${k}`} className="flex items-center gap-2">
                <RadioGroupItem id={`type-${k}`} value={k} />
                {t(`parties.types.${k}`)}
              </label>
            ))}
          </RadioGroup>
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('parties.form.name')} error={errors['name']} className="sm:col-span-2">
          {(c) => (
            <TranslitInput
              {...c}
              data-autofocus
              data-testid="party-name"
              value={draft.name}
              onValueChange={(name, nameLatin) => change({ name, nameLatin })}
            />
          )}
        </Field>
        {full && (
          <Field label={t('parties.form.tradeName')} className="sm:col-span-2">
            {(c) => (
              <Input
                {...c}
                value={draft.tradeName}
                onChange={(e) => change({ tradeName: e.target.value })}
              />
            )}
          </Field>
        )}
        <Field label={t('parties.form.country')} error={errors['country']}>
          {(c) => (
            <Input
              {...c}
              data-testid="party-country"
              value={draft.country}
              onChange={(e) => change({ country: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('parties.form.phone')} error={errors['phone']}>
          {(c) => (
            <Input
              {...c}
              data-testid="party-phone"
              inputMode="tel"
              value={draft.phone}
              onChange={(e) => change({ phone: e.target.value })}
            />
          )}
        </Field>
      </div>

      {!exporting && (
        <div className="flex flex-col gap-3">
          <Field
            label={t('parties.form.gstin')}
            error={errors['gstin']}
            hint={t('parties.form.gstinHelp')}
          >
            {(c) => (
              <GstinInput
                {...c}
                data-testid="party-gstin"
                value={draft.gstin}
                onValueChange={(gstin) => change({ gstin })}
              />
            )}
          </Field>
          {derived ? (
            <p className="text-sm text-fg-muted" data-testid="party-derived">
              {t('welcome.gstin.derived', {
                state: derived.stateName,
                code: derived.stateCode,
                pan: derived.pan,
                entity: entityType(derived.pan)?.label ?? '',
              })}
            </p>
          ) : (
            <Field
              label={t('parties.form.state')}
              error={errors['stateCode']}
              hint={draft.gstin ? undefined : t('parties.form.unregisteredHelp')}
            >
              {(c) => (
                <Select
                  value={draft.stateCode}
                  onValueChange={(stateCode) => change({ stateCode })}
                >
                  <SelectTrigger {...c} data-testid="party-state">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {STATE_OPTIONS.map(([code, name]) => (
                      <SelectItem key={code} value={code}>
                        {name} ({code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          )}
          {full && derived && (
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2" htmlFor="party-sez">
                <Checkbox
                  id="party-sez"
                  checked={draft.isSez}
                  onCheckedChange={(v) => change({ isSez: v === true })}
                />
                {t('parties.form.sez')}
              </label>
              <label className="flex items-center gap-2" htmlFor="party-composition">
                <Checkbox
                  id="party-composition"
                  checked={draft.isComposition}
                  onCheckedChange={(v) => change({ isComposition: v === true })}
                />
                {t('parties.form.composition')}
              </label>
            </div>
          )}
        </div>
      )}
      {exporting && <p className="text-sm text-fg-muted">{t('parties.form.exportNote')}</p>}

      {full && (
        <>
          <section className="flex flex-col gap-3">
            <h3 className="font-medium">{t('parties.form.billing')}</h3>
            <AddressFields
              prefix="billing"
              value={draft.billing}
              onChange={(billing) => change({ billing })}
              errors={errors}
            />
            <label className="flex items-center gap-2" htmlFor="ship-same">
              <Checkbox
                id="ship-same"
                checked={draft.shippingSame}
                onCheckedChange={(v) => change({ shippingSame: v === true })}
              />
              {t('parties.form.shippingSame')}
            </label>
            {!draft.shippingSame && (
              <>
                <h3 className="font-medium">{t('parties.form.shipping')}</h3>
                <AddressFields
                  prefix="shipping"
                  value={draft.shipping}
                  onChange={(shipping) => change({ shipping })}
                  errors={errors}
                />
              </>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="font-medium">{t('parties.form.contacts')}</h3>
            {draft.contacts.map((c, i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Field label={t('parties.form.contactName')}>
                  {(p) => (
                    <Input
                      {...p}
                      value={c.name}
                      onChange={(e) =>
                        change({
                          contacts: draft.contacts.map((x, j) =>
                            j === i ? { ...x, name: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <Field label={t('parties.form.phone')} error={errors[`contact${i}Phone`]}>
                  {(p) => (
                    <Input
                      {...p}
                      value={c.phone}
                      onChange={(e) =>
                        change({
                          contacts: draft.contacts.map((x, j) =>
                            j === i ? { ...x, phone: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <Field label={t('parties.form.email')} error={errors[`contact${i}Email`]}>
                  {(p) => (
                    <Input
                      {...p}
                      value={c.email}
                      onChange={(e) =>
                        change({
                          contacts: draft.contacts.map((x, j) =>
                            j === i ? { ...x, email: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  className="self-end"
                  onClick={() => change({ contacts: draft.contacts.filter((_, j) => j !== i) })}
                >
                  {t('parties.form.remove')}
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                data-testid="add-contact"
                onClick={() =>
                  change({ contacts: [...draft.contacts, { name: '', phone: '', email: '' }] })
                }
              >
                {t('parties.form.addContact')}
              </Button>
            </div>
            <Field label={t('parties.form.email')} error={errors['email']}>
              {(c) => (
                <Input
                  {...c}
                  type="email"
                  value={draft.email}
                  onChange={(e) => change({ email: e.target.value })}
                />
              )}
            </Field>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <h3 className="font-medium sm:col-span-2">{t('parties.form.terms')}</h3>
            <Field label={t('parties.form.language')} className="sm:col-span-2">
              {(c) => (
                <Select
                  value={draft.language || 'default'}
                  onValueChange={(v) => change({ language: v === 'default' ? '' : v })}
                >
                  <SelectTrigger {...c} data-testid="party-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t('parties.form.languageDefault')}</SelectItem>
                    {PRINT_LANGUAGES.map((l) => (
                      <SelectItem key={l} value={l} lang={l}>
                        {PRINT_LANGUAGE_NAMES[l]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label={t('parties.form.creditDays')} error={errors['creditDays']}>
              {(c) => (
                <Input
                  {...c}
                  data-testid="party-credit-days"
                  inputMode="numeric"
                  value={draft.creditDays}
                  onChange={(e) => change({ creditDays: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('parties.form.creditLimit')} error={errors['creditLimit']}>
              {(c) => (
                <Input
                  {...c}
                  data-testid="party-credit-limit"
                  inputMode="decimal"
                  value={draft.creditLimit}
                  onChange={(e) => change({ creditLimit: e.target.value })}
                />
              )}
            </Field>
            <Field
              label={t('parties.form.opening')}
              error={errors['opening']}
              hint={t('parties.form.openingHelp')}
            >
              {(c) => (
                <Input
                  {...c}
                  data-testid="party-opening"
                  inputMode="decimal"
                  value={draft.opening}
                  onChange={(e) => change({ opening: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('parties.form.openingSide')}>
              {(c) => (
                <Select
                  value={draft.openingSide}
                  onValueChange={(v) => change({ openingSide: v as PartyDraft['openingSide'] })}
                >
                  <SelectTrigger {...c} data-testid="party-opening-side">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="they-owe">{t('parties.form.theyOwe')}</SelectItem>
                    <SelectItem value="we-owe">{t('parties.form.weOwe')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label={t('parties.form.openingDate')} error={errors['openingDate']}>
              {() => (
                <div className="max-w-48">
                  <DatePicker
                    value={isoToDate(draft.openingDate)}
                    onChange={(d) => change({ openingDate: d ? dateToIso(d) : '' })}
                  />
                </div>
              )}
            </Field>
          </section>

          <section className="grid gap-4">
            <Field label={t('parties.form.tags')} hint={t('parties.form.tagsHelp')}>
              {(c) => (
                <Input
                  {...c}
                  data-testid="party-tags"
                  value={draft.tags}
                  onChange={(e) => change({ tags: e.target.value })}
                />
              )}
            </Field>
            <Field label={t('parties.form.notes')}>
              {(c) => (
                <TranslitInput
                  {...(c as object)}
                  multiline
                  rows={3}
                  value={draft.notes}
                  onValueChange={(notes) => change({ notes })}
                />
              )}
            </Field>
          </section>
        </>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy} data-testid="party-save">
          {submitLabel ?? t('parties.form.save')}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} data-testid="party-cancel">
            {t('parties.form.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

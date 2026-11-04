/** Form sections shared by the setup wizard and Settings -> Business. */
import { PRESETS, PRESET_IDS, STATES, entityType, type PresetId } from '@gst/domain';
import {
  Checkbox,
  GstinInput,
  Input,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
} from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { Field } from '../onboarding/field';

import { deriveFromGstin, type BankDraft, type BusinessDraft, type Errors } from './profile';

type Change = (patch: Partial<BusinessDraft>) => void;

const STATE_OPTIONS = Object.entries(STATES).filter(([code]) => code !== '97' && code !== '99');

/** GSTIN (checksum validated), "not registered yet", state and composition. */
export function RegistrationFields({
  draft,
  onChange,
  errors,
}: {
  draft: BusinessDraft;
  onChange: Change;
  errors: Errors;
}) {
  const { t } = useTranslation();
  const derived = deriveFromGstin(draft);
  return (
    <div className="flex flex-col gap-4">
      {!draft.notRegistered && (
        <div>
          <Field
            label={t('welcome.gstin.label')}
            error={errors['gstin']}
            hint={t('welcome.gstin.help')}
          >
            {(c) => (
              <GstinInput
                {...c}
                data-autofocus
                value={draft.gstin}
                onValueChange={(gstin) => onChange({ gstin })}
              />
            )}
          </Field>
          {derived && (
            <p className="pt-1 text-sm text-fg-muted" data-testid="gstin-derived">
              {t('welcome.gstin.derived', {
                state: derived.stateName,
                code: derived.stateCode,
                pan: derived.pan,
                entity: entityType(derived.pan)?.label ?? '',
              })}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Checkbox
          id="not-registered"
          checked={draft.notRegistered}
          onCheckedChange={(v) =>
            onChange({
              notRegistered: v === true,
              composition: v === true ? false : draft.composition,
            })
          }
        />
        <label htmlFor="not-registered">{t('welcome.gstin.notRegistered')}</label>
      </div>

      {draft.notRegistered && (
        <Field label={t('welcome.gstin.state')} error={errors['stateCode']}>
          {(c) => (
            <Select value={draft.stateCode} onValueChange={(stateCode) => onChange({ stateCode })}>
              <SelectTrigger {...c} data-autofocus data-testid="state-select">
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

      <div className={cn('flex items-start gap-3', draft.notRegistered && 'opacity-50')}>
        <Switch
          id="composition"
          aria-describedby="composition-help"
          checked={draft.composition}
          disabled={draft.notRegistered}
          onCheckedChange={(composition) => onChange({ composition })}
        />
        <div>
          <label htmlFor="composition" className="text-sm font-medium">
            {t('welcome.gstin.composition')}
          </label>
          <p id="composition-help" className="text-xs text-fg-muted">
            {t('welcome.gstin.compositionHelp')}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Names, address and contact. */
export function DetailsFields({
  draft,
  onChange,
  errors,
}: {
  draft: BusinessDraft;
  onChange: Change;
  errors: Errors;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label={t('welcome.details.legalName')}
        error={errors['legalName']}
        className="sm:col-span-2"
      >
        {(c) => (
          <Input
            {...c}
            data-autofocus
            value={draft.legalName}
            onChange={(e) => onChange({ legalName: e.target.value })}
          />
        )}
      </Field>
      <Field label={t('welcome.details.tradeName')} className="sm:col-span-2">
        {(c) => (
          <Input
            {...c}
            value={draft.tradeName}
            onChange={(e) => onChange({ tradeName: e.target.value })}
          />
        )}
      </Field>
      <Field label={t('welcome.details.line1')} error={errors['line1']} className="sm:col-span-2">
        {(c) => (
          <Input {...c} value={draft.line1} onChange={(e) => onChange({ line1: e.target.value })} />
        )}
      </Field>
      <Field label={t('welcome.details.city')}>
        {(c) => (
          <Input {...c} value={draft.city} onChange={(e) => onChange({ city: e.target.value })} />
        )}
      </Field>
      <Field label={t('welcome.details.pincode')} error={errors['pincode']}>
        {(c) => (
          <Input
            {...c}
            inputMode="numeric"
            value={draft.pincode}
            onChange={(e) => onChange({ pincode: e.target.value })}
          />
        )}
      </Field>
      <Field label={t('welcome.details.phone')} error={errors['phone']}>
        {(c) => (
          <Input
            {...c}
            inputMode="tel"
            value={draft.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
          />
        )}
      </Field>
      <Field label={t('welcome.details.email')} error={errors['email']}>
        {(c) => (
          <Input
            {...c}
            type="email"
            value={draft.email}
            onChange={(e) => onChange({ email: e.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

/** One radio card per preset. */
export function PresetPicker({
  value,
  onChange,
}: {
  value: PresetId;
  onChange: (p: PresetId) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-fg-muted">{t('welcome.presetHelp')}</p>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as PresetId)}
        aria-label={t('welcome.steps.preset')}
        className="grid gap-2 sm:grid-cols-2"
      >
        {PRESET_IDS.map((id) => (
          <label
            key={id}
            htmlFor={`preset-${id}`}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-3',
              value === id ? 'border-accent bg-surface-1' : 'border-border hover:bg-surface-1',
            )}
          >
            <RadioGroupItem
              id={`preset-${id}`}
              value={id}
              data-autofocus={id === value ? true : undefined}
            />
            <span>
              <span className="block font-medium">{PRESETS[id].label}</span>
              <span className="block text-sm text-fg-muted">{PRESETS[id].description}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}

export function BankFields({
  bank,
  onChange,
  errors,
}: {
  bank: BankDraft;
  onChange: (patch: Partial<BankDraft>) => void;
  errors: Errors;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Checkbox
          id="bank-enable"
          data-autofocus
          checked={bank.enabled}
          onCheckedChange={(v) => onChange({ enabled: v === true })}
        />
        <label htmlFor="bank-enable">{t('welcome.bank.enable')}</label>
      </div>
      {bank.enabled && (
        <>
          <RadioGroup
            value={bank.kind}
            onValueChange={(v) => onChange({ kind: v as 'bank' | 'upi' })}
            aria-label={t('welcome.bank.kind')}
            className="flex gap-4"
          >
            {(['bank', 'upi'] as const).map((k) => (
              <label key={k} htmlFor={`kind-${k}`} className="flex items-center gap-2">
                <RadioGroupItem id={`kind-${k}`} value={k} />
                {t(`welcome.bank.${k}`)}
              </label>
            ))}
          </RadioGroup>
          {bank.kind === 'bank' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('welcome.bank.bankName')}
                error={errors['bankName']}
                className="sm:col-span-2"
              >
                {(c) => (
                  <Input
                    {...c}
                    value={bank.name}
                    onChange={(e) => onChange({ name: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('welcome.bank.accountNo')} error={errors['accountNo']}>
                {(c) => (
                  <Input
                    {...c}
                    inputMode="numeric"
                    value={bank.accountNo}
                    onChange={(e) => onChange({ accountNo: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('welcome.bank.ifsc')} error={errors['ifsc']}>
                {(c) => (
                  <Input
                    {...c}
                    className="uppercase"
                    value={bank.ifsc}
                    onChange={(e) => onChange({ ifsc: e.target.value })}
                  />
                )}
              </Field>
            </div>
          ) : (
            <Field label={t('welcome.bank.upiId')} error={errors['upiId']}>
              {(c) => (
                <Input
                  {...c}
                  value={bank.upiId}
                  onChange={(e) => onChange({ upiId: e.target.value })}
                />
              )}
            </Field>
          )}
        </>
      )}
    </div>
  );
}

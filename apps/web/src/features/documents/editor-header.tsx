import type { Row } from '@gst/db';
import { STATES, addDays, supplyOf, type DraftDocument, type DraftIssue } from '@gst/domain';
import {
  Badge,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { PartyPicker } from './party-picker';
import { applyParty, isPurchase } from './state';

import { Field } from '@/features/onboarding/field';

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY'] as const;
const STATE_OPTIONS = Object.entries(STATES).filter(([code]) => code !== '97' && code !== '99');
const REF_FIELDS = ['po', 'challan'] as const;

const errorOf = (issues: DraftIssue[], field: string): string | undefined => {
  const i = issues.find((x) => x.field === field);
  return i ? i.code : undefined;
};

/**
 * Who, when and where for a document. Place of supply follows the party and can be changed (with a
 * warning); the supply type shown is what the tax engine will use, live.
 */
export function EditorHeader({
  draft,
  issues,
  showIssues,
  readOnly,
  businessState,
  numberLabel,
  simple = false,
  onPartyPicked,
  onChange,
}: {
  draft: DraftDocument;
  issues: DraftIssue[];
  /** Show problems on the fields (after the first attempt to issue). */
  showIssues: boolean;
  readOnly: boolean;
  businessState: string;
  numberLabel: string;
  /** Shop: just who and when. */
  simple?: boolean;
  /** Called after a party is chosen, so the cursor can move on to the lines. */
  onPartyPicked?: () => void;
  onChange: (f: (d: DraftDocument) => DraftDocument) => void;
}) {
  const { t } = useTranslation();
  const purchase = isPurchase(draft.type);
  const supply = supplyOf(draft);
  const partyState = draft.partyId ? (purchase ? draft.supplierState : draft.placeOfSupply) : null;
  const defaultPos = purchase ? businessState : (partyState ?? businessState);
  const posChanged =
    !draft.export && draft.placeOfSupply !== '' && draft.placeOfSupply !== defaultPos;
  const err = (field: string) => (showIssues ? errorOf(issues, field) : undefined);
  const vErr = (field: string) => {
    const code = err(field);
    return code ? `doc_${code}` : undefined;
  };
  const set = (patch: Partial<DraftDocument>) => onChange((d) => ({ ...d, ...patch }));

  if (simple) {
    return (
      <section
        className="grid gap-4 sm:grid-cols-[1fr_12rem]"
        aria-label={t('docs.header.title')}
        data-testid="doc-header"
      >
        <PartyPicker
          type={draft.type}
          name={draft.partyName}
          disabled={readOnly}
          error={vErr('party')}
          onPick={(p: Row | null) => {
            onChange((d) => applyParty(d, p, { businessState }));
            if (p) onPartyPicked?.();
          }}
        />
        <Field label={t('docs.header.date')} error={vErr('date')}>
          {(c) => (
            <Input
              {...c}
              type="date"
              disabled={readOnly}
              data-testid="doc-date"
              value={draft.date}
              onChange={(e) => set({ date: e.target.value })}
            />
          )}
        </Field>
      </section>
    );
  }

  return (
    <section
      className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))]"
      aria-label={t('docs.header.title')}
      data-testid="doc-header"
    >
      <div className="sm:col-span-2">
        <PartyPicker
          type={draft.type}
          name={draft.partyName}
          disabled={readOnly}
          error={vErr('party')}
          onPick={(p: Row | null) => {
            onChange((d) => applyParty(d, p, { businessState }));
            if (p) onPartyPicked?.();
          }}
        />
      </div>

      <Field label={t('docs.header.number')}>
        {(c) => <Input {...c} readOnly disabled value={numberLabel} data-testid="doc-number" />}
      </Field>

      <Field label={t('docs.header.date')} error={vErr('date')}>
        {(c) => (
          <Input
            {...c}
            type="date"
            disabled={readOnly}
            data-testid="doc-date"
            value={draft.date}
            onChange={(e) =>
              onChange((d) => ({
                ...d,
                date: e.target.value,
                // the payment term stays the same when the date moves
                dueDate: d.dueDate ? shiftDate(d.dueDate, d.date, e.target.value) : d.dueDate,
              }))
            }
          />
        )}
      </Field>

      {!['quotation', 'delivery_challan', 'proforma'].includes(draft.type) && (
        <Field label={t('docs.header.dueDate')} error={vErr('dueDate')}>
          {(c) => (
            <Input
              {...c}
              type="date"
              disabled={readOnly}
              data-testid="doc-due"
              value={draft.dueDate ?? ''}
              onChange={(e) => set({ dueDate: e.target.value || null })}
            />
          )}
        </Field>
      )}

      <div className="flex flex-col gap-1">
        <Field label={t('docs.header.pos')} error={vErr('placeOfSupply')}>
          {(c) => (
            <Select
              value={draft.placeOfSupply || undefined}
              disabled={readOnly || draft.export}
              onValueChange={(v) => set({ placeOfSupply: v })}
            >
              <SelectTrigger {...c} data-testid="doc-pos">
                <SelectValue placeholder={t('docs.header.posPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {STATE_OPTIONS.map(([code, name]) => (
                  <SelectItem key={code} value={code}>
                    {name} ({code})
                  </SelectItem>
                ))}
                {draft.export && (
                  <SelectItem value="96">{t('docs.header.outsideIndia')}</SelectItem>
                )}
              </SelectContent>
            </Select>
          )}
        </Field>
        {posChanged && (
          <p role="status" className="text-xs text-warning" data-testid="pos-warning">
            {t('docs.header.posWarning', { state: STATES[defaultPos] ?? defaultPos })}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t('docs.header.supply')}</span>
        <Badge data-testid="supply-badge" data-supply={supply} className="w-fit">
          {t(`docs.supply.${supply}`)}
        </Badge>
        <span className="text-xs text-fg-muted">{t(`docs.supplyHelp.${supply}`)}</span>
      </div>

      <Field label={t('docs.header.discountMode')}>
        {(c) => (
          <Select
            value={draft.discountMode}
            disabled={readOnly}
            onValueChange={(v) => set({ discountMode: v as DraftDocument['discountMode'] })}
          >
            <SelectTrigger {...c} data-testid="doc-discount-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('docs.discount.none')}</SelectItem>
              <SelectItem value="percent">{t('docs.discount.percent')}</SelectItem>
              <SelectItem value="per_unit">{t('docs.discount.per_unit')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </Field>

      <label className="flex items-center gap-2 self-end pb-2 text-sm" htmlFor="doc-rcm">
        <Switch
          id="doc-rcm"
          data-testid="doc-rcm"
          checked={draft.reverseCharge}
          disabled={readOnly}
          onCheckedChange={(v) => set({ reverseCharge: v })}
        />
        {t('docs.header.reverseCharge')}
      </label>

      {!purchase && (
        <label className="flex items-center gap-2 self-end pb-2 text-sm" htmlFor="doc-export">
          <Checkbox
            id="doc-export"
            data-testid="doc-export"
            checked={draft.export}
            disabled={readOnly}
            onCheckedChange={(v) =>
              onChange((d) =>
                v === true
                  ? { ...d, export: true, placeOfSupply: '96', lut: true }
                  : {
                      ...d,
                      export: false,
                      lut: d.sez ? d.lut : false,
                      currency: 'INR',
                      fxRateMicros: 1_000_000n,
                      placeOfSupply: d.partyState ?? businessState,
                    },
              )
            }
          />
          {t('docs.header.export')}
        </label>
      )}

      {(draft.export || draft.sez) && (
        <label className="flex items-center gap-2 self-end pb-2 text-sm" htmlFor="doc-lut">
          <Checkbox
            id="doc-lut"
            data-testid="doc-lut"
            checked={draft.lut}
            disabled={readOnly}
            onCheckedChange={(v) => set({ lut: v === true })}
          />
          {t('docs.header.lut')}
        </label>
      )}

      {draft.export && (
        <>
          <Field label={t('docs.header.currency')}>
            {(c) => (
              <Select
                value={draft.currency}
                disabled={readOnly}
                onValueChange={(v) =>
                  set({ currency: v, ...(v === 'INR' ? { fxRateMicros: 1_000_000n } : {}) })
                }
              >
                <SelectTrigger {...c} data-testid="doc-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((cur) => (
                    <SelectItem key={cur} value={cur}>
                      {cur}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          {draft.currency !== 'INR' && (
            <Field
              label={t('docs.header.fxRate', { currency: draft.currency })}
              error={vErr('fxRateMicros')}
            >
              {(c) => (
                <Input
                  {...c}
                  inputMode="decimal"
                  disabled={readOnly}
                  data-testid="doc-fx"
                  defaultValue={String(Number(draft.fxRateMicros) / 1_000_000)}
                  onBlur={(e) => {
                    const m = /^\d+(\.\d{1,6})?$/.exec(e.target.value.trim());
                    if (m) {
                      const [i, f = ''] = e.target.value.trim().split('.');
                      set({ fxRateMicros: BigInt(i!) * 1_000_000n + BigInt(f.padEnd(6, '0')) });
                    }
                  }}
                />
              )}
            </Field>
          )}
        </>
      )}

      {REF_FIELDS.map((k) => (
        <Field key={k} label={t(`docs.header.ref.${k}`)}>
          {(c) => (
            <Input
              {...c}
              disabled={readOnly}
              data-testid={`doc-ref-${k}`}
              value={draft.refs[k] ?? ''}
              onChange={(e) => set({ refs: { ...draft.refs, [k]: e.target.value } })}
            />
          )}
        </Field>
      ))}

      <Field label={t('docs.header.series')} hint={t('docs.header.seriesHelp')}>
        {(c) => <Input {...c} readOnly disabled value={t('docs.header.seriesAuto')} />}
      </Field>
      <Field label={t('docs.header.template')} hint={t('docs.header.templateHelp')}>
        {(c) => <Input {...c} readOnly disabled value={t('docs.header.templateStandard')} />}
      </Field>
    </section>
  );
}

/** `due` moved by as many days as the date moved from `from` to `to`. */
function shiftDate(due: string, from: string, to: string): string {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  return Number.isFinite(days) && days !== 0 ? addDays(due, days) : due;
}

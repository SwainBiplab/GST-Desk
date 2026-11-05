import { DocumentFlowRepo } from '@gst/db';
import {
  TCS_206C1H_SUNSET,
  FIFTY_LAKH,
  fyOf,
  parseAmountPaise,
  parseRateBp,
  toDecimalString,
  type BuiltDocument,
  type DraftDocument,
} from '@gst/domain';
import {
  Button,
  Input,
  MoneyText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  formatPaise,
} from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RichTextField } from './rich-text-field';
import { isPurchase } from './state';

import { useAppDb } from '@/app/db';
import { Field } from '@/features/onboarding/field';
import { useTerm } from '@/lib/terms';

type TaxMode = 'none' | 'tcs' | 'tds_buyer' | 'tds_us';

const modeOf = (d: DraftDocument): TaxMode =>
  d.tcs ? 'tcs' : d.tds ? (isPurchase(d.type) ? 'tds_us' : 'tds_buyer') : 'none';

/**
 * What goes under the grid: invoice-level discount, round-off, TCS or TDS (with the threshold checked
 * against what this party has already been invoiced this financial year), notes and terms. Totals
 * shown here are the engine's and open the trace.
 */
export function EditorFooter({
  draft,
  built,
  readOnly,
  documentId,
  simple = false,
  onChange,
  onTrace,
}: {
  draft: DraftDocument;
  built: BuiltDocument;
  readOnly: boolean;
  documentId: string | null;
  /** Shop: totals only. */
  simple?: boolean;
  onChange: (f: (d: DraftDocument) => DraftDocument) => void;
  onTrace: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx, business } = useAppDb();
  const mode = modeOf(draft);
  const purchase = isPurchase(draft.type);
  const set = (patch: Partial<DraftDocument>) => onChange((d) => ({ ...d, ...patch }));
  const [fy, setFy] = useState<{ sales: bigint; purchases: bigint } | null>(null);

  // what this party has been invoiced (or we have bought from it) this financial year
  useEffect(() => {
    if (!database || !ctx || !draft.partyId || mode === 'none') return;
    let live = true;
    const year = fyOf(draft.date, Number(business?.['fy_start_month'] ?? 4));
    void new DocumentFlowRepo(database)
      .fyTotals(ctx, draft.partyId, year.start, year.end, documentId ?? undefined)
      .then((r) => {
        if (!live) return;
        setFy({ sales: r.salesPaise, purchases: r.purchasesTaxablePaise });
        onChange((d) => {
          if (d.tcs && d.tcs.cumulativeBeforePaise !== r.salesPaise)
            return { ...d, tcs: { ...d.tcs, cumulativeBeforePaise: r.salesPaise } };
          if (d.tds) {
            const base = isPurchase(d.type) ? r.purchasesTaxablePaise : r.salesPaise;
            if (d.tds.cumulativeBeforePaise !== base)
              return { ...d, tds: { ...d.tds, cumulativeBeforePaise: base } };
          }
          return d;
        });
      });
    return () => {
      live = false;
    };
    // `onChange` is stable; the totals depend on the party, the date and the chosen section
  }, [database, ctx, draft.partyId, draft.date, mode, documentId, business, onChange]);

  const chooseMode = (m: TaxMode) =>
    onChange((d) => {
      const base = { ...d, tcs: null, tds: null };
      if (m === 'tcs')
        // 0.1%, or 1% when the buyer has no PAN (we only know a PAN from a GSTIN)
        return {
          ...base,
          tcs: { rateBp: d.partyGstin ? 10 : 100, cumulativeBeforePaise: fy?.sales ?? 0n },
        };
      if (m === 'tds_buyer' || m === 'tds_us')
        return {
          ...base,
          tds: {
            rateBp: 10,
            cumulativeBeforePaise: (m === 'tds_us' ? fy?.purchases : fy?.sales) ?? 0n,
            applicable: true,
          },
        };
      return base;
    });

  const discount = draft.invoiceDiscount;
  const options: TaxMode[] = purchase ? ['none', 'tds_us'] : ['none', 'tcs', 'tds_buyer'];
  const sunset = mode === 'tcs' && draft.date >= TCS_206C1H_SUNSET;
  const base = mode === 'tcs' ? fy?.sales : mode === 'tds_us' ? fy?.purchases : fy?.sales;

  if (simple) {
    return (
      <section
        className="ml-auto w-full max-w-80"
        aria-label={t('docs.footer.title')}
        data-testid="doc-footer"
      >
        <TotalsBox built={built} onTrace={onTrace} />
      </section>
    );
  }

  return (
    <section
      className="grid gap-4 lg:grid-cols-[1fr_20rem]"
      aria-label={t('docs.footer.title')}
      data-testid="doc-footer"
    >
      <div className="flex flex-col gap-4">
        <RichTextField
          label={t('docs.footer.notes')}
          value={draft.notes}
          disabled={readOnly}
          testId="doc-notes"
          onChange={(notes) => set({ notes })}
        />
        <RichTextField
          label={t('docs.footer.terms')}
          value={draft.terms}
          disabled={readOnly}
          testId="doc-terms"
          onChange={(terms) => set({ terms })}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('docs.footer.invoiceDiscount')}>
            {(c) => (
              <Select
                value={discount?.mode ?? 'none'}
                disabled={readOnly}
                onValueChange={(v) =>
                  set({
                    invoiceDiscount:
                      v === 'none'
                        ? null
                        : v === 'percent'
                          ? { mode: 'percent', bp: 0 }
                          : { mode: 'amount', paise: 0n },
                  })
                }
              >
                <SelectTrigger {...c} data-testid="doc-inv-discount-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('docs.discount.none')}</SelectItem>
                  <SelectItem value="percent">{t('docs.footer.invDiscountPercent')}</SelectItem>
                  <SelectItem value="amount">{t('docs.footer.invDiscountAmount')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
          {discount && (
            <Field label={t('docs.footer.invoiceDiscountValue')}>
              {(c) => (
                <Input
                  {...c}
                  inputMode="decimal"
                  disabled={readOnly}
                  data-testid="doc-inv-discount"
                  key={discount.mode}
                  defaultValue={
                    discount.mode === 'percent'
                      ? discount.bp === 0
                        ? ''
                        : String(discount.bp / 100)
                      : discount.paise === 0n
                        ? ''
                        : toDecimalString(discount.paise)
                  }
                  onChange={(e) => {
                    const text = e.target.value;
                    if (discount.mode === 'percent') {
                      const bp = text.trim() === '' ? 0 : parseRateBp(text);
                      if (typeof bp === 'number' && bp <= 10_000)
                        set({ invoiceDiscount: { mode: 'percent', bp } });
                    } else {
                      const p = text.trim() === '' ? 0 : parseAmountPaise(text);
                      if (typeof p === 'number')
                        set({ invoiceDiscount: { mode: 'amount', paise: BigInt(p) } });
                    }
                  }}
                />
              )}
            </Field>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm" htmlFor="doc-roundoff">
          <Switch
            id="doc-roundoff"
            data-testid="doc-roundoff"
            checked={draft.roundOff}
            disabled={readOnly}
            onCheckedChange={(v) => set({ roundOff: v })}
          />
          {t('docs.footer.roundOff')}
        </label>

        <Field label={t('docs.footer.taxSection')}>
          {(c) => (
            <Select
              value={mode}
              disabled={readOnly || !draft.partyId}
              onValueChange={(v) => chooseMode(v as TaxMode)}
            >
              <SelectTrigger {...c} data-testid="doc-tax-section">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o} value={o}>
                    {t(`docs.footer.section.${o}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        {mode !== 'none' && (
          <p className="text-xs text-fg-muted" data-testid="tax-section-hint">
            {t('docs.footer.threshold', {
              total: base === undefined ? '...' : toDecimalString(base),
              limit: toDecimalString(FIFTY_LAKH),
            })}
            {sunset && ` ${t('docs.footer.tcsSunset')}`}
          </p>
        )}

        <TotalsBox built={built} onTrace={onTrace} />
      </div>
    </section>
  );
}

/** The totals, each of which opens the trace. */
export function TotalsBox({ built, onTrace }: { built: BuiltDocument; onTrace: () => void }) {
  const { t } = useTranslation();
  const term = useTerm();
  const t0 = built.totals;
  return (
    <dl
      className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm"
      data-testid="doc-totals"
    >
      <TotalRow label={t('docs.totals.taxable')} paise={t0.taxablePaise} onTrace={onTrace} />
      {t0.invoiceDiscountPaise > 0n && (
        <TotalRow
          label={t('docs.totals.invoiceDiscount')}
          paise={-t0.invoiceDiscountPaise}
          onTrace={onTrace}
        />
      )}
      {t0.cgstPaise > 0n && (
        <TotalRow label={term('cgst')} paise={t0.cgstPaise} onTrace={onTrace} />
      )}
      {t0.sgstPaise > 0n && (
        <TotalRow label={term('sgst')} paise={t0.sgstPaise} onTrace={onTrace} />
      )}
      {t0.utgstPaise > 0n && (
        <TotalRow label={term('utgst')} paise={t0.utgstPaise} onTrace={onTrace} />
      )}
      {t0.igstPaise > 0n && (
        <TotalRow label={term('igst')} paise={t0.igstPaise} onTrace={onTrace} />
      )}
      {t0.cessPaise > 0n && (
        <TotalRow label={t('docs.totals.cess')} paise={t0.cessPaise} onTrace={onTrace} />
      )}
      {t0.tcsPaise > 0n && <TotalRow label={term('tcs')} paise={t0.tcsPaise} onTrace={onTrace} />}
      {t0.roundOffPaise !== 0n && (
        <TotalRow label={t('docs.totals.roundOff')} paise={t0.roundOffPaise} onTrace={onTrace} />
      )}
      {t0.rcmTaxPaise > 0n && (
        <div className="flex justify-between text-fg-muted" data-testid="rcm-note">
          <dt>{t('docs.totals.rcm')}</dt>
          <dd>
            <MoneyText paise={t0.rcmTaxPaise} />
          </dd>
        </div>
      )}
      <TotalRow
        label={t('docs.totals.total')}
        paise={t0.totalPaise}
        onTrace={onTrace}
        strong
        testId="doc-total"
      />
      {t0.tdsPaise > 0n && (
        <TotalRow label={t('docs.totals.tds')} paise={-t0.tdsPaise} onTrace={onTrace} />
      )}
    </dl>
  );
}

function TotalRow({
  label,
  paise,
  onTrace,
  strong,
  testId,
}: {
  label: string;
  paise: bigint;
  onTrace: () => void;
  strong?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`flex items-center justify-between ${strong ? 'border-t border-border pt-1 text-base font-semibold' : ''}`}
    >
      <dt>{label}</dt>
      <dd>
        <Button
          type="button"
          variant="ghost"
          className="h-6 px-1 tabular"
          // the name starts with what the button shows, then says what it does
          aria-label={`${formatPaise(paise)}, ${t('docs.trace.explain', { label })}`}
          data-testid={testId ?? 'doc-total-row'}
          onClick={onTrace}
        >
          <MoneyText paise={paise} negativeRed />
        </Button>
      </dd>
    </div>
  );
}

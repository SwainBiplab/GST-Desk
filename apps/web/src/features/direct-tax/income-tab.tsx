import {
  advanceTaxSchedule,
  estimateIncomeTax,
  type Estimate,
  type Regime,
  type RegimeResult,
} from '@gst/domain';
import {
  Button,
  Card,
  Checkbox,
  Input,
  MoneyInput,
  MoneyText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  formatPaise,
} from '@gst/ui';
import { parsePaise } from '@gst/ui';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Field } from './common';
import { emptyIncomeForm, useBooksFigures, useIncomeForm, type IncomeForm } from './hooks';
import { formToInput } from './model';

import { dyn } from '@/lib/dyn-key';

const toText = (p: bigint): string =>
  p === 0n ? '' : formatPaise(p, { symbol: false }).replace(/,/g, '');

/** The income-tax estimate: the form on the left, both regimes beside it, advance tax and interest below. */
export function IncomeTab({ fy }: { fy: string }) {
  const { saved, loaded, save } = useIncomeForm(fy);
  // the form only mounts once the saved copy is here, so a late load can never overwrite what was typed
  if (!loaded) return null;
  return <IncomeBody key={fy} fy={fy} initial={saved ?? emptyIncomeForm()} save={save} />;
}

function IncomeBody({
  fy,
  initial,
  save,
}: {
  fy: string;
  initial: IncomeForm;
  save: (f: IncomeForm) => Promise<void>;
}) {
  const { t } = useTranslation();
  const books = useBooksFigures(fy).data;
  const [form, setForm] = useState<IncomeForm>(initial);
  const [dirty, setDirty] = useState(false);

  // keep what was typed: save a moment after the last change, and not at all until there is one
  useEffect(() => {
    if (!dirty) return;
    const id = setTimeout(() => void save(form), 600);
    return () => clearTimeout(id);
  }, [form, save, dirty]);

  const set = <K extends keyof IncomeForm>(k: K, v: IncomeForm[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const money = (k: keyof IncomeForm) => ({
    value: parsePaise(String(form[k])),
    onValueChange: (p: bigint | null) => set(k, (p === null ? '' : toText(p)) as never),
  });

  const result = useMemo(() => estimateIncomeTax(formToInput(form, fy)), [form, fy]);
  const est: Estimate | null = 'error' in result ? null : result;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3" data-testid="income-form">
        <h2 className="text-base font-semibold">{t('directTax.income.heading')}</h2>
        <p role="note" className="rounded-md border border-warning bg-warning/10 p-2 text-sm">
          {t('directTax.income.estimate')}
        </p>
        <p className="text-sm text-fg-muted">{t('directTax.income.hint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('directTax.income.age')}>
            <Select value={form.age} onValueChange={(v) => set('age', v as IncomeForm['age'])}>
              <SelectTrigger
                className="w-40"
                aria-label={t('directTax.income.age')}
                data-testid="income-age"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['below60', 'senior', 'super_senior'] as const).map((a) => (
                  <SelectItem key={a} value={a}>
                    {t(dyn(`directTax.income.ages.${a}`))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('directTax.income.method')}>
            <Select
              value={form.method}
              onValueChange={(v) => set('method', v as IncomeForm['method'])}
            >
              <SelectTrigger
                className="w-64"
                aria-label={t('directTax.income.method')}
                data-testid="income-method"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['books', '44AD', '44ADA'] as const).map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(dyn(`directTax.income.methods.${m}`))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {form.method === 'books' ? (
            <>
              <Field label={t('directTax.income.netProfit')} className="min-w-56">
                <MoneyInput {...money('netProfit')} data-testid="income-profit" />
              </Field>
              <Button
                variant="outline"
                disabled={!books}
                onClick={() => books && set('netProfit', toText(books.profit))}
                data-testid="income-use-books"
              >
                {t('directTax.income.useBooks')}
              </Button>
            </>
          ) : null}
          {form.method === '44AD' ? (
            <>
              <Field label={t('directTax.income.turnover')} className="min-w-56">
                <MoneyInput {...money('turnover')} data-testid="income-turnover" />
              </Field>
              <Field label={t('directTax.income.digital')} className="min-w-32">
                <Input
                  value={form.digitalPct}
                  inputMode="decimal"
                  onChange={(e) => set('digitalPct', e.target.value)}
                />
              </Field>
              <Button
                variant="outline"
                disabled={!books}
                onClick={() => books && set('turnover', toText(books.turnover))}
              >
                {t('directTax.income.useBooks')}
              </Button>
            </>
          ) : null}
          {form.method === '44ADA' ? (
            <>
              <Field label={t('directTax.income.receipts')} className="min-w-56">
                <MoneyInput {...money('receipts')} />
              </Field>
              <Field label={t('directTax.income.cash')} className="min-w-32">
                <Input
                  value={form.cashPct}
                  inputMode="decimal"
                  onChange={(e) => set('cashPct', e.target.value)}
                />
              </Field>
              <Button
                variant="outline"
                disabled={!books}
                onClick={() => books && set('receipts', toText(books.turnover))}
              >
                {t('directTax.income.useBooks')}
              </Button>
            </>
          ) : null}
          <Field label={t('directTax.income.other')} className="min-w-56">
            <MoneyInput {...money('other')} />
          </Field>
        </div>

        <h3 className="pt-2 text-sm font-semibold">{t('directTax.income.deductions')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('directTax.income.d80c')} className="min-w-52">
            <MoneyInput {...money('d80c')} data-testid="income-80c" />
          </Field>
          <Field label={t('directTax.income.d80ccd')} className="min-w-52">
            <MoneyInput {...money('d80ccd')} />
          </Field>
          <Field label={t('directTax.income.d80dSelf')} className="min-w-52">
            <MoneyInput {...money('d80dSelf')} />
          </Field>
          <Field label={t('directTax.income.d80dParents')} className="min-w-52">
            <MoneyInput {...money('d80dParents')} />
          </Field>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox
              checked={form.parentsSenior}
              onCheckedChange={(v) => set('parentsSenior', v === true)}
            />
            {t('directTax.income.parentsSenior')}
          </label>
          <Field label={t('directTax.income.homeLoan')} className="min-w-52">
            <MoneyInput {...money('homeLoan')} />
          </Field>
          <Field label={t('directTax.income.dOther')} className="min-w-52">
            <MoneyInput {...money('dOther')} />
          </Field>
        </div>

        <h3 className="pt-2 text-sm font-semibold">{t('directTax.income.advance')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('directTax.income.credit')} className="min-w-64">
            <MoneyInput {...money('credit')} data-testid="income-credit" />
          </Field>
          <Field label={t('directTax.income.filing')}>
            <Input
              type="date"
              value={form.filing}
              onChange={(e) => set('filing', e.target.value)}
            />
          </Field>
        </div>
        <ul className="flex flex-col gap-2">
          {form.advance.map((a, i) => (
            <li key={i} className="flex flex-wrap items-end gap-3">
              <Field label={t('directTax.income.advanceDate')}>
                <Input
                  type="date"
                  value={a.date}
                  onChange={(e) =>
                    set(
                      'advance',
                      form.advance.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)),
                    )
                  }
                />
              </Field>
              <Field label={t('directTax.income.advanceAmount')} className="min-w-48">
                <MoneyInput
                  value={parsePaise(a.amount)}
                  onValueChange={(p) =>
                    set(
                      'advance',
                      form.advance.map((x, j) =>
                        j === i ? { ...x, amount: p === null ? '' : toText(p) } : x,
                      ),
                    )
                  }
                />
              </Field>
              <Button
                variant="ghost"
                onClick={() =>
                  set(
                    'advance',
                    form.advance.filter((_, j) => j !== i),
                  )
                }
              >
                {t('directTax.receivable.remove')}
              </Button>
            </li>
          ))}
        </ul>
        <div>
          <Button
            variant="outline"
            onClick={() => set('advance', [...form.advance, { date: '', amount: '' }])}
            data-testid="income-add-advance"
          >
            {t('directTax.income.addAdvance')}
          </Button>
        </div>
      </Card>

      {!est ? (
        <p role="alert" className="text-sm text-danger">
          {t('directTax.income.error', { message: 'error' in result ? result.error : '' })}
        </p>
      ) : (
        <div className="flex flex-col gap-4 print-area" data-testid="income-result">
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-base font-semibold">
                {t('directTax.income.resultHeading', { fy, ay: est.assessmentYear })}
              </h2>
              <Button
                className="ml-auto print:hidden"
                variant="outline"
                onClick={() => window.print()}
              >
                {t('directTax.income.print')}
              </Button>
            </div>
            <p className="text-sm font-medium" data-testid="income-better">
              {t('directTax.income.better', {
                regime: t(
                  est.better === 'new'
                    ? 'directTax.income.newRegime'
                    : 'directTax.income.oldRegime',
                ),
              })}
              {est.savingPaise > 0n
                ? `. ${t('directTax.income.saving', { amount: formatPaise(est.savingPaise) })}`
                : ''}
            </p>
            <RegimeTable est={est} />
            <ul className="flex flex-col gap-1 text-sm text-fg-muted">
              {est.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <p className="text-sm font-medium">{t('directTax.income.estimate')}</p>
          </Card>
          <Schedule est={est} fy={fy} />
        </div>
      )}
    </div>
  );
}

function RegimeTable({ est }: { est: Estimate }) {
  const { t } = useTranslation();
  const rows: [string, (r: RegimeResult) => bigint][] = [
    ['directTax.income.grossIncome', (r) => r.incomePaise],
    ['directTax.income.deductionsAllowed', (r) => r.deductionsPaise],
    ['directTax.income.taxable', (r) => r.taxableIncomePaise],
    ['directTax.income.slab', (r) => r.slabTaxPaise],
    ['directTax.income.rebate', (r) => -r.rebatePaise],
    ['directTax.income.surcharge', (r) => r.surchargePaise],
    ['directTax.income.cess', (r) => r.cessPaise],
    ['directTax.income.total', (r) => r.totalTaxPaise],
  ];
  const regimes: Regime[] = ['new', 'old'];
  return (
    <Table data-testid="regime-table">
      <TableHead>
        <TableRow>
          <TableHeaderCell />
          {regimes.map((r) => (
            <TableHeaderCell key={r} className="text-right">
              {t(r === 'new' ? 'directTax.income.newRegime' : 'directTax.income.oldRegime')}
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(([label, f]) => (
          <TableRow
            key={label}
            className={label === 'directTax.income.total' ? 'font-semibold' : ''}
          >
            <TableCell>{t(dyn(label))}</TableCell>
            {regimes.map((r) => (
              <TableCell
                key={r}
                className="text-right"
                data-testid={`${label.split('.').pop()}-${r}`}
              >
                <MoneyText paise={f(est[r])} />
              </TableCell>
            ))}
          </TableRow>
        ))}
        <TableRow>
          <TableCell>{t('directTax.income.afterCredits')}</TableCell>
          {regimes.map((r) => (
            <TableCell key={r} className="text-right">
              <MoneyText paise={est.interest[r].assessedPaise} />
            </TableCell>
          ))}
        </TableRow>
        <TableRow>
          <TableCell>{t('directTax.income.interest')}</TableCell>
          {regimes.map((r) => (
            <TableCell key={r} className="text-right">
              <MoneyText paise={est.interest[r].totalPaise} />
            </TableCell>
          ))}
        </TableRow>
        <TableRow className="font-semibold">
          <TableCell>{t('directTax.income.payable')}</TableCell>
          {regimes.map((r) => (
            <TableCell key={r} className="text-right" data-testid={`payable-${r}`}>
              <MoneyText paise={est.payablePaise[r]} />
            </TableCell>
          ))}
        </TableRow>
      </TableBody>
    </Table>
  );
}

function Schedule({ est, fy }: { est: Estimate; fy: string }) {
  const { t } = useTranslation();
  const i = est.interest[est.better];
  const plan = advanceTaxSchedule(fy, i.assessedPaise, est.presumptive);
  return (
    <Card className="flex flex-col gap-3" data-testid="advance-schedule">
      <h3 className="text-base font-semibold">
        {t('directTax.income.schedule')} (
        {t(est.better === 'new' ? 'directTax.income.newRegime' : 'directTax.income.oldRegime')})
      </h3>
      {plan.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('directTax.income.scheduleNone')}</p>
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('directTax.cols.date')}</TableHeaderCell>
              <TableHeaderCell className="text-right">
                {t('directTax.income.required')}
              </TableHeaderCell>
              <TableHeaderCell className="text-right">{t('directTax.income.paid')}</TableHeaderCell>
              <TableHeaderCell className="text-right">
                {t('directTax.income.short')}
              </TableHeaderCell>
              <TableHeaderCell className="text-right">
                {t('directTax.income.months')}
              </TableHeaderCell>
              <TableHeaderCell className="text-right">
                {t('directTax.income.i234c')}
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {i.instalments.map((x) => (
              <TableRow key={x.dueDate}>
                <TableCell>{x.dueDate}</TableCell>
                <TableCell className="text-right">
                  <MoneyText paise={x.requiredPaise} />
                </TableCell>
                <TableCell className="text-right">
                  <MoneyText paise={x.paidPaise} />
                </TableCell>
                <TableCell className="text-right">
                  <MoneyText paise={x.shortfallPaise} />
                </TableCell>
                <TableCell className="text-right">{x.months}</TableCell>
                <TableCell className="text-right">
                  <MoneyText paise={x.interestPaise} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {i.section234BPaise > 0n ? (
        <p className="text-sm">
          {t('directTax.income.i234b', {
            amount: formatPaise(i.section234BPaise),
            months: i.section234BMonths,
          })}
        </p>
      ) : null}
    </Card>
  );
}

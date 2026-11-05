import type { Dashboard } from '@gst/db';
import { Card, CardTitle, MoneyText } from '@gst/ui';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  BarList,
  ChartCard,
  ColumnChart,
  DataTable,
  LineChart,
  type Group,
  type Series,
} from './charts';
import { useDashboard } from './hooks';
import { qtyText } from './model';

import { useAppNavigate } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { ChecklistCard } from '@/features/business/checklist-card';
import { useFeatureFlags } from '@/features/business/hooks';

type Search = Record<string, string>;

/** A number that opens the report it came from, with the same filters. */
function Drill({
  testId,
  onOpen,
  children,
  label,
}: {
  testId: string;
  onOpen: () => void;
  children: ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      onClick={onOpen}
      className="rounded text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {children}
    </button>
  );
}

const monthName = (period: string): string => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};
const dayName = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
};

/**
 * Eases a card's answer in when it arrives after a "Working it out" state. A card that already had
 * its data when it appeared (cached, or a refresh after a payment) shows it at once: numbers the
 * user reads never move for style, and arriving by keyboard shortcut stays instant.
 */
function Reveal({
  ready,
  order,
  children,
}: {
  ready: boolean;
  order: number;
  children: ReactNode;
}) {
  const [arrivedLate] = useState(!ready);
  return (
    <div
      className={ready && arrivedLate ? 'dash-in' : undefined}
      style={{ ['--dash-delay' as string]: `${order * 40}ms` }}
    >
      {children}
    </div>
  );
}

const BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;

/** Stacked bar of receivables by age, with each segment's amount in its tooltip and legend. */
function AgeingBar({ ageing, total }: { ageing: Dashboard['receivablesAgeing']; total: number }) {
  const { t } = useTranslation();
  const positive = BUCKETS.map((b) => Math.max(0, ageing[b]));
  const sum = positive.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return null;
  return (
    <div className="pt-2" data-testid="dash-ageing">
      <div
        className="flex h-2 overflow-hidden rounded bg-surface-1"
        role="img"
        aria-label={t('dash.ageingLabel')}
      >
        {BUCKETS.map((b, i) =>
          positive[i]! > 0 ? (
            <div
              key={b}
              style={{ width: `${(positive[i]! / sum) * 100}%`, opacity: 0.35 + i * 0.16 }}
              className="bg-accent"
              title={`${t(`reports.bucket.${b}`)}: ${(positive[i]! / 100).toLocaleString('en-IN')}`}
            />
          ) : null,
        )}
      </div>
      <ul className="flex flex-wrap gap-x-3 pt-1 text-xs text-fg-muted">
        {BUCKETS.map((b, i) =>
          positive[i]! > 0 ? (
            <li key={b}>
              {t(`reports.bucket.${b}`)} <MoneyText paise={positive[i]!} />
            </li>
          ) : null,
        )}
      </ul>
    </div>
  );
}

function Big({ paise, testId }: { paise: number; testId: string }) {
  return (
    <p className="pt-1 text-2xl font-semibold" data-testid={testId}>
      <MoneyText paise={paise} negativeRed />
    </p>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthShort = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1]!;
const lastDayOf = (m: string) =>
  new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();

/** The charts under the cards: what the numbers above add up to, over time and by customer. */
function ChartsSection({ d, shell }: { d: Dashboard; shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const c = d.charts;
  const custom = (id: string, from: string, to: string) =>
    navigate(`/${shell}/reports`, { report: id, preset: 'custom', from, to });
  const monthRange = (m: string) => {
    const end = `${m}-${String(lastDayOf(m)).padStart(2, '0')}`;
    return { from: `${m}-01`, to: end > c.anchorDate ? c.anchorDate : end };
  };

  const months: Group[] = c.months.map((m) => ({
    label: monthShort(m.month),
    title: `${monthShort(m.month)} ${m.month.slice(0, 4)}`,
    values: {
      sales: m.salesPaise,
      spend: m.spendPaise,
      receipts: m.receiptsPaise,
      payments: m.paymentsPaise,
    },
  }));
  const trend: Series[] = [
    { key: 'sales', label: t('dash.chart.sales'), color: '--viz-1' },
    { key: 'spend', label: t('dash.chart.spend'), color: '--viz-2' },
  ];
  const cash: Series[] = [
    { key: 'receipts', label: t('dash.chart.moneyIn'), color: '--viz-1' },
    { key: 'payments', label: t('dash.chart.moneyOut'), color: '--viz-2' },
  ];
  const days: Group[] = c.days.map((x) => ({
    label: String(Number(x.date.slice(8, 10))),
    title: `${Number(x.date.slice(8, 10))} ${monthShort(x.date.slice(0, 7))} ${x.date.slice(0, 4)}`,
    values: { sales: x.salesPaise },
  }));
  const daySeries: Series[] = [{ key: 'sales', label: t('dash.chart.sales'), color: '--viz-1' }];
  const note = c.anchored ? t('dash.chart.anchored', { date: c.anchorDate }) : undefined;

  const trendCard = (
    <ChartCard
      key="trend"
      testId="chart-trend"
      title={t('dash.chart.trendTitle')}
      note={note}
      table={
        <DataTable
          caption={t('dash.chart.trendTitle')}
          groups={months}
          series={trend}
          first={t('dash.chart.month')}
        />
      }
    >
      <ColumnChart
        groups={months}
        series={trend}
        caption={t('dash.chart.trendTitle')}
        onSelect={(i, key) => {
          const r = monthRange(c.months[i]!.month);
          custom(key === 'sales' ? 'sales_register' : 'purchase_register', r.from, r.to);
        }}
      />
    </ChartCard>
  );
  const cashCard = (
    <ChartCard
      key="cash"
      testId="chart-cash"
      title={t('dash.chart.cashTitle')}
      note={note}
      table={
        <DataTable
          caption={t('dash.chart.cashTitle')}
          groups={months}
          series={cash}
          first={t('dash.chart.month')}
        />
      }
    >
      <LineChart groups={months} series={cash} caption={t('dash.chart.cashTitle')} />
    </ChartCard>
  );
  const daysCard = (
    <ChartCard
      key="days"
      testId="chart-days"
      title={t('dash.chart.daysTitle')}
      note={note}
      table={
        <DataTable
          caption={t('dash.chart.daysTitle')}
          groups={days}
          series={daySeries}
          first={t('dash.chart.day')}
        />
      }
    >
      <ColumnChart
        groups={days}
        series={daySeries}
        caption={t('dash.chart.daysTitle')}
        onSelect={(i) => custom('sales_register', c.days[i]!.date, c.days[i]!.date)}
      />
    </ChartCard>
  );
  const customersCard = (
    <ChartCard
      key="customers"
      testId="chart-customers"
      title={t('dash.chart.customersTitle')}
      note={note}
    >
      {c.topParties.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('dash.chart.noCustomers')}</p>
      ) : (
        <BarList
          caption={t('dash.chart.customersTitle')}
          rows={c.topParties.map((p, i) => ({
            key: `${p.partyId ?? 'walk-in'}-${i}`,
            label: p.name || t('reports.walkIn'),
            paise: p.paise,
            ...(p.partyId
              ? { onOpen: () => navigate(`/${shell}/parties`, { open: p.partyId }) }
              : {}),
          }))}
        />
      )}
    </ChartCard>
  );

  const AGE_KEYS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
  const ageingCard = (
    <ChartCard key="ageing" testId="chart-ageing" title={t('dash.chart.ageingTitle')}>
      {d.receivablesPaise <= 0 ? (
        <p className="text-sm text-fg-muted">{t('dash.chart.noReceivables')}</p>
      ) : (
        <BarList
          caption={t('dash.chart.ageingTitle')}
          rows={AGE_KEYS.map((k) => ({
            key: k,
            label: t(`reports.bucket.${k}`),
            paise: Math.max(0, d.receivablesAgeing[k]),
            onOpen: () =>
              navigate(`/${shell}/reports`, { report: 'party_outstanding', side: 'receivable' }),
          }))}
        />
      )}
    </ChartCard>
  );

  return (
    <div className="grid gap-3 pt-3 md:grid-cols-2" data-testid="dashboard-charts">
      {shell === 'shop'
        ? [daysCard, customersCard]
        : [trendCard, cashCard, customersCard, ageingCard]}
    </div>
  );
}

/** The question-led cards of the Shop and Books dashboards (UX-06). Every number opens its report. */
export function DashboardCards({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const flags = useFeatureFlags();
  const d = useDashboard();
  const report = (id: string, extra: Search = {}) =>
    navigate(`/${shell}/reports`, { report: id, ...extra });

  const keys =
    shell === 'shop'
      ? ['sold', 'owed', 'low', 'attention']
      : ['gst', 'cash', 'overdue', 'spend', 'month', 'review'];

  const card = (key: string, children: ReactNode) => (
    <Card key={key} data-testid={`card-${key}`} className="min-h-32">
      <CardTitle>{t(`dash.${shell === 'shop' ? 'shop' : 'books'}.${key}`)}</CardTitle>
      <Reveal ready={!!d} order={keys.indexOf(key)}>
        {d ? children : <p className="pt-2 text-fg-muted">{t('dash.loading')}</p>}
      </Reveal>
    </Card>
  );

  const render = (key: string): ReactNode => {
    if (!d) return card(key, null);
    switch (`${shell}.${key}`) {
      case 'shop.sold':
        return card(
          key,
          <>
            <Drill
              testId="dash-sales-today"
              onOpen={() => report('sales_register', { preset: 'today' })}
            >
              <Big paise={d.salesTodayPaise} testId="dash-sales-today-value" />
            </Drill>
            <p className="text-sm text-fg-muted">
              <Drill
                testId="dash-bills-today"
                onOpen={() => report('sales_register', { preset: 'today' })}
              >
                {t('dash.billsToday', { count: d.billsToday })}
              </Drill>
              {' · '}
              <Drill
                testId="dash-cash-today"
                onOpen={() => report('receipts_payments', { preset: 'today', book: 'cash' })}
              >
                {t('dash.cashToday')} <MoneyText paise={d.cashReceivedTodayPaise} />
              </Drill>
            </p>
            {d.topItemsToday.length > 0 && (
              <ol className="pt-2 text-sm" data-testid="dash-top-items">
                {d.topItemsToday.slice(0, 3).map((it, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate">{it.name}</span>
                    <span className="tabular text-fg-muted">{qtyText(it.qtyMicros)}</span>
                  </li>
                ))}
              </ol>
            )}
            {d.salesTodayPaise === 0 && d.billsToday === 0 && (
              <p className="pt-2 text-sm text-fg-muted">{t('dash.noSalesToday')}</p>
            )}
          </>,
        );
      case 'shop.owed':
      case 'books.cash':
        return card(
          key,
          <>
            {shell === 'books' && (
              <p className="text-sm text-fg-muted">
                <Drill
                  testId="dash-cash-in-hand"
                  onOpen={() => report('receipts_payments', { book: 'cash' })}
                >
                  {t('dash.cashInHand')} <MoneyText paise={d.cashInHandPaise} negativeRed />
                </Drill>
              </p>
            )}
            <Drill
              testId="dash-receivables"
              onOpen={() => report('party_outstanding', { side: 'receivable' })}
            >
              <Big paise={d.receivablesPaise} testId="dash-receivables-value" />
            </Drill>
            <p className="text-sm text-fg-muted">{t('dash.toCollect')}</p>
            <AgeingBar ageing={d.receivablesAgeing} total={d.receivablesPaise} />
            {shell === 'books' && (
              <p className="pt-2 text-sm">
                <Drill
                  testId="dash-payables"
                  onOpen={() => report('party_outstanding', { side: 'payable' })}
                >
                  {t('dash.toPay')} <MoneyText paise={d.payablesPaise} />
                </Drill>
              </p>
            )}
            {shell === 'shop' && d.overdueCount > 0 && (
              <p className="pt-2 text-sm">
                <Drill
                  testId="dash-overdue-count"
                  onOpen={() => report('party_outstanding', { side: 'receivable' })}
                >
                  {t('dash.overdueCount', { count: d.overdueCount })} ·{' '}
                  <MoneyText paise={d.overduePaise} />
                </Drill>
              </p>
            )}
          </>,
        );
      case 'shop.low':
        return card(
          key,
          !flags.inventory ? (
            <p className="pt-2 text-sm text-fg-muted" data-testid="dash-stock-off">
              {t('dash.stockOff')}
            </p>
          ) : d.lowStock.count === 0 ? (
            <p className="pt-2 text-sm text-fg-muted" data-testid="dash-low-none">
              {t('dash.nothingLow')}
            </p>
          ) : (
            <>
              <Drill
                testId="dash-low-count"
                onOpen={() => report('stock_summary', { preset: 'today', type: 'low' })}
              >
                <p className="pt-1 text-2xl font-semibold">
                  {t('dash.lowCount', { count: d.lowStock.count })}
                </p>
              </Drill>
              <ul className="pt-2 text-sm" data-testid="dash-low-list">
                {d.lowStock.items.map((i) => (
                  <li key={i.itemId} className="flex justify-between gap-2">
                    <span className="truncate">{i.name}</span>
                    <span className="tabular text-fg-muted">
                      {qtyText(i.closingMicros)} / {qtyText(i.minMicros)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ),
        );
      case 'books.review':
      case 'shop.attention':
        return card(
          key,
          <ul className="space-y-1 pt-2 text-sm">
            <li>
              <Drill testId="dash-drafts" onOpen={() => navigate(`/${shell}/documents`, {})}>
                {t('dash.drafts', { count: d.drafts })}
              </Drill>
            </li>
            <li>
              <Drill testId="dash-inbox" onOpen={() => navigate(`/${shell}/inbox`, {})}>
                {t('dash.inbox', { count: d.inbox })}
              </Drill>
            </li>
            {flags.inventory && (
              <li>
                <Drill
                  testId="dash-low-link"
                  onOpen={() => report('stock_summary', { preset: 'today', type: 'low' })}
                >
                  {t('dash.lowCount', { count: d.lowStock.count })}
                </Drill>
              </li>
            )}
          </ul>,
        );
      case 'books.gst':
        return card(
          key,
          <>
            <Drill
              testId="dash-gst"
              onOpen={() => report('gst_summary', { preset: 'this_month', type: 'outward' })}
            >
              <Big paise={d.gstEstimate.payablePaise} testId="dash-gst-value" />
            </Drill>
            <p className="text-sm text-fg-muted">
              {d.gstEstimate.payablePaise < 0 ? t('dash.gstCredit') : t('dash.gstPayable')}
              {' · '}
              <Drill
                testId="dash-gst-output"
                onOpen={() => report('gst_summary', { preset: 'this_month', type: 'outward' })}
              >
                {t('dash.gstOutput')} <MoneyText paise={d.gstEstimate.outputPaise} />
              </Drill>
              {' · '}
              <Drill
                testId="dash-gst-input"
                onOpen={() => report('gst_summary', { preset: 'this_month', type: 'inward' })}
              >
                {t('dash.gstInput')} <MoneyText paise={d.gstEstimate.inputPaise} />
              </Drill>
            </p>
            <ul className="space-y-1 pt-2 text-sm" data-testid="dash-filing">
              {d.filing.slice(0, 3).map((f) => (
                <li key={`${f.form}${f.period}`}>
                  <span className="block">
                    {t(`dash.form.${f.form}`)} · {monthName(f.period)}
                  </span>
                  <span
                    className={`block text-xs ${f.inDays < 0 ? 'text-danger' : 'text-fg-muted'}`}
                  >
                    {dayName(f.due)} ·{' '}
                    {f.inDays < 0
                      ? t('dash.late', { count: -f.inDays })
                      : t('dash.inDays', { count: f.inDays })}
                  </span>
                </li>
              ))}
            </ul>
            <p className="pt-1 text-xs text-fg-muted">{t('dash.filingNote')}</p>
          </>,
        );
      case 'books.overdue':
        return card(
          key,
          d.overdueCount === 0 ? (
            <p className="pt-2 text-sm text-fg-muted" data-testid="dash-overdue-none">
              {t('dash.noOverdue')}
            </p>
          ) : (
            <>
              <Drill
                testId="dash-overdue-total"
                onOpen={() => report('party_outstanding', { side: 'receivable' })}
              >
                <Big paise={d.overduePaise} testId="dash-overdue-value" />
              </Drill>
              <p className="text-sm text-fg-muted">
                {t('dash.overdueCount', { count: d.overdueCount })}
              </p>
              <ul className="space-y-2 pt-2 text-sm" data-testid="dash-overdue-list">
                {d.overdue.map((o) => (
                  <li key={o.id}>
                    <Drill
                      testId="dash-overdue-row"
                      onOpen={() =>
                        o.partyId ? navigate(`/${shell}/parties`, { open: o.partyId }) : undefined
                      }
                    >
                      <span className="block truncate">{o.partyName || o.number}</span>
                    </Drill>
                    <span className="tabular block text-xs text-fg-muted">
                      <MoneyText paise={o.balancePaise} /> ·{' '}
                      {t('dash.daysLate', { count: o.daysOverdue })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ),
        );
      case 'books.spend':
        return card(
          key,
          <>
            <Drill
              testId="dash-spend"
              onOpen={() => report('purchase_register', { preset: 'this_month' })}
            >
              <Big paise={d.monthSpendPaise} testId="dash-spend-value" />
            </Drill>
            <p className="text-sm text-fg-muted">{t('dash.spendNote')}</p>
            <p className="pt-1 text-sm">
              <Drill
                testId="dash-expenses"
                onOpen={() => report('expense_summary', { preset: 'this_month' })}
              >
                {t('dash.byCategory')}
              </Drill>
            </p>
          </>,
        );
      case 'books.month': {
        const diff = d.monthSalesPaise - d.lastMonthSalesPaise;
        return card(
          key,
          <>
            <Drill
              testId="dash-month"
              onOpen={() => report('sales_register', { preset: 'this_month' })}
            >
              <Big paise={d.monthSalesPaise} testId="dash-month-value" />
            </Drill>
            <p className="text-sm text-fg-muted">
              <Drill
                testId="dash-last-month"
                onOpen={() => report('sales_register', { preset: 'last_month' })}
              >
                {t('dash.lastMonth')} <MoneyText paise={d.lastMonthSalesPaise} />
              </Drill>
              {' · '}
              <span data-testid="dash-month-diff" className={diff < 0 ? 'text-danger' : ''}>
                {diff >= 0 ? '+' : '−'}
                <MoneyText paise={Math.abs(diff)} />
              </span>
            </p>
          </>,
        );
      }
      default:
        return card(key, null);
    }
  };

  return (
    <div data-testid="dashboard-frame">
      <ChecklistCard />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{keys.map(render)}</div>
      {d && <ChartsSection d={d} shell={shell} />}
    </div>
  );
}

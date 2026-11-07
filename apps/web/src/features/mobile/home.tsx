/**
 * Home on the phone (prompt 43): today's numbers, the three things a counter does most (new bill,
 * scan a bill, take money), what waits in the inbox, and the latest documents with swipe actions.
 */
import { DocumentRepo, type Row } from '@gst/db';
import { Button, Card, formatPaise } from '@gst/ui';
import { Camera, Plus, Wallet } from '@gst/ui/icons';
import { useTranslation } from 'react-i18next';

import { defaultSaleFor } from '../documents/use-editor';

import { useScanBill } from './scan';
import { SwipeRow } from './swipe';

import { useAppDb, useLiveQuery } from '@/app/db';
import { useAppNavigate, useCounts, useTodaySummary } from '@/app/hooks';
import { dyn } from '@/lib/dyn-key';

export function MobileHome() {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const { business } = useAppDb();
  const today = useTodaySummary();
  const counts = useCounts();
  const scan = useScanBill();
  const recent = useLiveQuery<Row[]>({
    tables: ['documents'],
    key: ['mobile-recent'],
    fn: (d, c) => new DocumentRepo(d).listBy(c, { limit: 8 }),
  });
  const saleType = defaultSaleFor(business);
  const open = (r: Row) => navigate('/shop/sell', { type: r['type'], id: r['id'] });

  const cell = (label: string, value: number | undefined, id: string) => (
    <div className="flex flex-col" data-testid={id}>
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="tabular text-lg font-semibold">
        {value === undefined ? '—' : formatPaise(value)}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-3" data-testid="mobile-home">
      <Card className="grid grid-cols-3 gap-2 p-3">
        {cell(t('strip.sales'), today?.salesPaise, 'home-sales')}
        {cell(t('strip.cash'), today?.cashReceivedPaise, 'home-cash')}
        {cell(t('strip.pending'), today?.pendingPaise, 'home-pending')}
      </Card>
      <Button
        className="min-h-14 text-base"
        data-testid="home-new-bill"
        onClick={() => navigate('/shop/sell', { type: saleType, fresh: Date.now() })}
      >
        <Plus size={20} aria-hidden />
        {t('mobile.home.newBill')}
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          className="min-h-12"
          data-testid="home-scan"
          disabled={scan.busy || !scan.ready}
          onClick={() => void scan.scan()}
        >
          <Camera size={18} aria-hidden />
          {scan.busy ? t('mobile.scan.capturing') : t('mobile.home.scanBill')}
        </Button>
        <Button
          variant="secondary"
          className="min-h-12"
          data-testid="home-receive"
          onClick={() => navigate('/shop/payments', { intent: 'receive' })}
        >
          <Wallet size={18} aria-hidden />
          {t('mobile.home.receive')}
        </Button>
      </div>
      {!!counts?.reviewPending && (
        <button
          type="button"
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-left text-sm"
          data-testid="home-waiting"
          onClick={() => navigate('/shop/inbox')}
        >
          {t('mobile.home.waiting', { count: counts.reviewPending })}
        </button>
      )}
      <section>
        <h2 className="pb-1 text-sm font-medium text-fg-muted">{t('mobile.home.recent')}</h2>
        {recent.data?.length === 0 && (
          <p className="text-sm text-fg-muted" data-testid="home-no-documents">
            {t('mobile.home.noDocuments')}
          </p>
        )}
        <ul className="divide-y divide-border rounded-md border border-border">
          {(recent.data ?? []).map((r) => (
            <li key={String(r['id'])}>
              <SwipeRow
                testId="home-doc"
                actions={[
                  { id: 'open', label: t('mobile.home.open'), tone: 'accent', run: () => open(r) },
                ]}
              >
                <button
                  type="button"
                  className="flex min-h-14 w-full items-center gap-3 px-3 text-left"
                  onClick={() => open(r)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {String(r['party_name'] || t('mobile.bill.noParty'))}
                    </span>
                    <span className="block text-xs text-fg-muted">
                      {String(r['number'] ?? t(dyn(`docs.status.${String(r['status'])}`)))} ·{' '}
                      {String(r['date'])}
                    </span>
                  </span>
                  <span className="tabular text-sm font-semibold">
                    {formatPaise(Number(r['total_paise'] ?? 0))}
                  </span>
                </button>
              </SwipeRow>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

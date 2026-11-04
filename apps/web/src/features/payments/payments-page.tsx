import {
  CreditAppliedError,
  PaymentFlowRepo,
  type Direction,
  type PayMode,
  type PaymentListRow,
} from '@gst/db';
import { toCsv, toDecimalString, today, type CsvValue } from '@gst/domain';
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  Input,
  MoneyText,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PaymentForm } from './payment-form';
import { VoucherDialog } from './voucher-dialog';

import { useConfirm } from '@/app/components/confirm';
import { useAppDb, useLiveQuery } from '@/app/db';
import { parseCommand } from '@/app/grammar';
import { useAppNavigate, useLocationInfo } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { downloadText } from '@/features/parties/csv';
import { usePartySearch } from '@/features/parties/hooks';

const MODES: PayMode[] = ['cash', 'upi', 'card', 'bank', 'cheque', 'other', 'adjustment'];
const todayIso = () => today(() => new Date());
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface FormState {
  direction: Direction;
  partyId: string | null;
  amountPaise: bigint | null;
  editing: PaymentListRow | null;
}

/** Payments: receive and make payments, see them with filters and export, and (Shop) the day book. */
export function PaymentsPage({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const navigate = useAppNavigate();
  const { search } = useLocationInfo();
  const { database, ctx } = useAppDb();
  const shop = shell === 'shop';

  const [q, setQ] = useState('');
  const [direction, setDirection] = useState<'all' | Direction>('all');
  const [mode, setMode] = useState<'all' | PayMode>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // what the address asks for: ?intent=receive|pay [&party=id] or a command such as "receive 500 from Sharma"
  const intent = typeof search['intent'] === 'string' ? search['intent'] : null;
  const partyParam = typeof search['party'] === 'string' ? search['party'] : null;
  const cmd = typeof search['cmd'] === 'string' ? parseCommand(search['cmd']) : null;
  const command = cmd && cmd.kind === 'payment' ? cmd : null;
  const named = usePartySearch(command?.party ?? '');
  const searchKey = JSON.stringify([intent, partyParam, search['cmd'] ?? null]);
  const waitingForParty = !!command && !named.isSuccess;
  const fromAddress: FormState | null = waitingForParty
    ? null
    : command
      ? {
          direction: command.direction,
          partyId: named.data?.[0] ?? null,
          amountPaise: command.amountPaise,
          editing: null,
        }
      : intent === 'receive' || intent === 'pay'
        ? {
            direction: intent === 'pay' ? 'made' : 'received',
            partyId: partyParam,
            amountPaise: null,
            editing: null,
          }
        : null;
  // what the user opened or closed by hand wins over the address until the address changes
  const [override, setOverride] = useState<{ key: string; value: FormState | null } | null>(null);
  const form = override && override.key === searchKey ? override.value : fromAddress;
  const setForm = (value: FormState | null) => setOverride({ key: searchKey, value });
  const [voucher, setVoucher] = useState<PaymentListRow | null>(null);

  const rows = useLiveQuery<PaymentListRow[]>({
    tables: ['payments', 'payment_allocations', 'documents'],
    key: ['payments', q, direction, mode, from, to],
    fn: (d, c) =>
      new PaymentFlowRepo(d).listPayments(c, {
        ...(q.trim() ? { q } : {}),
        ...(direction !== 'all' ? { direction } : {}),
        ...(mode !== 'all' ? { mode } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }),
  });
  const list = rows.data ?? [];

  const exportCsv = () => {
    const out: CsvValue[][] = [
      [
        'Date',
        'Party',
        'Direction',
        'Mode',
        'Reference',
        'Receipt',
        'Amount',
        'TCS',
        'Settled',
        'Kept as credit',
      ],
      ...list.map((r): CsvValue[] => [
        r.date,
        r.partyName,
        r.direction === 'received' ? 'Received' : 'Paid',
        r.mode,
        r.reference ?? '',
        r.voucherNumber ?? '',
        { numeric: toDecimalString(r.amountPaise) },
        { numeric: toDecimalString(r.tcsPaise) },
        { numeric: toDecimalString(r.allocatedPaise) },
        { numeric: toDecimalString(r.unallocatedPaise) },
      ]),
    ];
    downloadText('payments.csv', toCsv(out));
  };

  /** A payment from before receipts existed (or demo data): make its receipt, then show it. */
  const createReceipt = async (r: PaymentListRow) => {
    if (!database || !ctx) return;
    try {
      const v = await new PaymentFlowRepo(database).createReceipt(ctx, r.id);
      toast.success(t('pay.receiptCreated', { number: String(v['number'] ?? '') }));
      setVoucher({
        ...r,
        voucherId: v['id'],
        voucherNumber: (v['number'] as string | null) ?? null,
      });
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const remove = async (r: PaymentListRow) => {
    if (!database || !ctx) return;
    if (
      !(await confirm({
        title: t('pay.deleteTitle'),
        description: t('pay.deleteBody'),
        confirmLabel: t('pay.deleteConfirm'),
      }))
    )
      return;
    const repo = new PaymentFlowRepo(database);
    try {
      await repo.remove(ctx, r.id);
      toast.success(t('pay.deleted'));
    } catch (e) {
      if (e instanceof CreditAppliedError) {
        if (
          await confirm({
            title: t('pay.deleteTitle'),
            description: t('pay.deleteForce', { count: e.documents.length }),
            confirmLabel: t('pay.deleteForceConfirm'),
          })
        )
          await repo
            .remove(ctx, r.id, { force: true })
            .then(() => toast.success(t('pay.deleted')))
            .catch((x: unknown) => toast.error(errText(x)));
      } else toast.error(errText(e));
    }
  };

  const showVoucherId = typeof search['voucher'] === 'string' ? search['voucher'] : null;
  // only a payment that really has a receipt can be shown (payments made, and demo data, have none)
  const voucherRow =
    voucher ??
    (showVoucherId ? list.find((r) => r.voucherId === showVoucherId) : undefined) ??
    null;

  const formNode = form && (
    <PaymentForm
      key={`${form.direction}:${form.partyId ?? ''}:${form.editing?.id ?? ''}`}
      direction={form.direction}
      partyId={form.partyId}
      amountPaise={form.amountPaise}
      editing={form.editing}
      onDone={() => setForm(null)}
      onCancel={() => setForm(null)}
    />
  );

  return (
    <div className="flex flex-col gap-4" data-testid="payments-page" data-shell={shell}>
      <PageHeader
        title={t('pay.title')}
        actions={
          <div className="flex gap-2">
            <Button
              data-testid="pay-receive"
              onClick={() =>
                setForm({ direction: 'received', partyId: null, amountPaise: null, editing: null })
              }
            >
              {t('pay.receive')}
            </Button>
            <Button
              variant="outline"
              data-testid="pay-make"
              onClick={() =>
                setForm({ direction: 'made', partyId: null, amountPaise: null, editing: null })
              }
            >
              {t('pay.make')}
            </Button>
          </div>
        }
      />

      {shop ? (
        form && (
          <Card className="p-4" data-testid="pay-inline">
            <CardTitle className="pb-3">
              {t(
                form.editing
                  ? 'pay.editTitle'
                  : form.direction === 'received'
                    ? 'pay.receiveTitle'
                    : 'pay.makeTitle',
              )}
            </CardTitle>
            {formNode}
          </Card>
        )
      ) : (
        <Sheet open={!!form} onOpenChange={(o) => !o && setForm(null)}>
          <SheetContent className="w-[min(40rem,100vw)] overflow-auto" data-testid="pay-sheet">
            <SheetTitle className="text-lg font-semibold">
              {form?.editing
                ? t('pay.editTitle')
                : form?.direction === 'made'
                  ? t('pay.makeTitle')
                  : t('pay.receiveTitle')}
            </SheetTitle>
            <SheetDescription className="sr-only">{t('pay.allocate')}</SheetDescription>
            <div className="pt-3">{formNode}</div>
          </SheetContent>
        </Sheet>
      )}

      {shop && <DayBook />}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('pay.search')}
          <Input data-testid="pay-search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <Select value={direction} onValueChange={(v) => setDirection(v as typeof direction)}>
          <SelectTrigger
            className="w-40"
            aria-label={t('pay.allDirections')}
            data-testid="pay-filter-direction"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('pay.allDirections')}</SelectItem>
            <SelectItem value="received">{t('pay.directionReceived')}</SelectItem>
            <SelectItem value="made">{t('pay.directionMade')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
          <SelectTrigger
            className="w-44"
            aria-label={t('pay.allModes')}
            data-testid="pay-filter-mode"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('pay.allModes')}</SelectItem>
            {MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {t(`pay.modes.${m}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('pay.from')}
          <Input
            type="date"
            data-testid="pay-filter-from"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('pay.to')}
          <Input
            type="date"
            data-testid="pay-filter-to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <Button
          variant="outline"
          data-testid="pay-export"
          disabled={list.length === 0}
          onClick={exportCsv}
        >
          {t('pay.exportCsv')}
        </Button>
      </div>

      {list.length === 0 && !rows.isLoading ? (
        <EmptyState title={t('pay.empty')} />
      ) : (
        <div className="overflow-auto rounded-md border border-border">
          <table
            className="w-full text-sm"
            data-testid="payments-table"
            aria-label={t('pay.title')}
          >
            <thead className="bg-surface-2 text-left text-xs text-fg-muted">
              <tr>
                <th className="p-2">{t('pay.date')}</th>
                <th className="p-2">{t('pay.party')}</th>
                <th className="p-2">{t('pay.voucherNumber')}</th>
                <th className="p-2">{t('pay.mode')}</th>
                <th className="p-2">{t('pay.reference')}</th>
                <th className="p-2 text-right">{t('pay.amount')}</th>
                <th className="p-2 text-right">{t('pay.allocated')}</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border hover:bg-surface-1"
                  data-testid="payment-row"
                  data-direction={r.direction}
                >
                  <td className="p-2 tabular">{r.date}</td>
                  <td className="p-2">{r.partyName}</td>
                  <td className="p-2">{r.voucherNumber ?? ''}</td>
                  <td className="p-2">{t(`pay.modes.${r.mode}`, { defaultValue: r.mode })}</td>
                  <td className="p-2">{r.reference ?? ''}</td>
                  <td className="p-2 text-right">
                    <MoneyText paise={r.amountPaise} />
                  </td>
                  <td className="p-2 text-right">
                    <MoneyText paise={r.allocatedPaise} />
                  </td>
                  <td className="whitespace-nowrap p-2 text-right">
                    {!r.voucherId && r.direction === 'received' && (
                      <Button
                        variant="ghost"
                        data-testid="pay-create-receipt"
                        onClick={() => void createReceipt(r)}
                      >
                        {t('pay.createReceipt')}
                      </Button>
                    )}
                    {r.voucherId && (
                      <Button
                        variant="ghost"
                        data-testid="pay-voucher"
                        onClick={() => setVoucher(r)}
                      >
                        {t('pay.voucher')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      data-testid="pay-edit"
                      onClick={() =>
                        setForm({
                          direction: r.direction,
                          partyId: r.partyId,
                          amountPaise: null,
                          editing: r,
                        })
                      }
                    >
                      {t('pay.edit')}
                    </Button>
                    <Button variant="ghost" data-testid="pay-delete" onClick={() => void remove(r)}>
                      {t('pay.delete')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {voucherRow && (
        <VoucherDialog
          row={voucherRow}
          onClose={() => {
            setVoucher(null);
            if (showVoucherId) navigate(`/${shell}/payments`, {});
          }}
        />
      )}
    </div>
  );
}

/** Cash in, cash out and the closing balance for a day, from the ledger's cash account. */
function DayBook() {
  const { t } = useTranslation();
  const [day, setDay] = useState(todayIso());
  const book = useLiveQuery({
    tables: ['payments', 'ledger_entries'],
    key: ['daybook', day],
    fn: (d, c) => new PaymentFlowRepo(d).dayBook(c, day),
  });
  const b = book.data;
  return (
    <Card className="p-4" data-testid="day-book">
      <div className="flex flex-wrap items-center gap-3 pb-2">
        <CardTitle>{t('pay.dayBook')}</CardTitle>
        <label className="flex items-center gap-2 text-sm">
          {t('pay.dayBookDate')}
          <Input
            type="date"
            className="w-44"
            data-testid="daybook-date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </label>
      </div>
      {b && (
        <dl className="grid gap-2 text-sm sm:grid-cols-4">
          {(
            [
              ['pay.cashOpening', b.openingPaise, 'daybook-opening'],
              ['pay.cashIn', b.inPaise, 'daybook-in'],
              ['pay.cashOut', b.outPaise, 'daybook-out'],
              ['pay.cashClosing', b.closingPaise, 'daybook-closing'],
            ] as const
          ).map(([label, v, id]) => (
            <div key={id}>
              <dt className="text-fg-muted">{t(label)}</dt>
              <dd className="text-base font-semibold" data-testid={id}>
                <MoneyText paise={v} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {b && b.entries.length === 0 && (
        <p className="pt-2 text-sm text-fg-muted">{t('pay.dayBookEmpty')}</p>
      )}
    </Card>
  );
}

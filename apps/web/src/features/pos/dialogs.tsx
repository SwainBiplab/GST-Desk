import {
  PosRepo,
  type BillLookup,
  type Counter,
  type HeldBill,
  type Shift,
  type ShiftReport,
} from '@gst/db';
import {
  TENDER_MODES,
  cashSuggestions,
  parseBillCode,
  parseQtyMicros,
  closeVariance,
  settleTenders,
  type Tender,
  type TenderMode,
  type ZReport,
} from '@gst/domain';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  formatPaise,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { parsePaise, qtyLabel, type PosSettings } from './model';

import { useAppDb, useLiveQuery } from '@/app/db';
import { upiLink } from '@/features/mobile/logic';
import { UpiQr } from '@/features/mobile/upi-qr';
import { dyn } from '@/lib/dyn-key';

/** Names of keys, not words: they are the same in every language. */
const KEY_ENTER = 'Enter';
const KEY_TAB = 'Tab';

/** Put the cursor in a field when it appears, so a person can type straight away. */
export const focusOnMount = (el: HTMLElement | null) => {
  if (el) requestAnimationFrame(() => el.focus());
};

const money = (p: bigint | number) => formatPaise(Number(p));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const rupees = (p: bigint) => (Number(p) / 100).toFixed(2);

/* ------------------------------------------------------------------ paying */

/**
 * Take payment for the bill: any mix of cash, UPI and card, checked as it is typed (card and UPI exact, cash may be
 * more and gives change). A UPI QR for what is left to pay after the other modes is shown on request.
 */
export function PayDialog({
  totalPaise,
  upiId,
  payee,
  onPay,
  onClose,
}: {
  totalPaise: bigint;
  upiId: string | null;
  payee: string;
  onPay: (tenders: Tender[]) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState<Record<TenderMode, string>>({
    cash: '',
    upi: '',
    card: '',
    other: '',
  });
  const [ref, setRef] = useState<Record<TenderMode, string>>({
    cash: '',
    upi: '',
    card: '',
    other: '',
  });
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const amounts = Object.fromEntries(
    TENDER_MODES.map((m) => [m, parsePaise(text[m]) ?? 0n]),
  ) as Record<TenderMode, bigint>;
  const bad = TENDER_MODES.some((m) => parsePaise(text[m]) === null);
  const tenders: Tender[] = TENDER_MODES.filter((m) => amounts[m] > 0n).map((m) => ({
    mode: m,
    amountPaise: amounts[m],
    ...(ref[m].trim() ? { reference: ref[m].trim() } : {}),
  }));
  const settled = settleTenders(totalPaise, tenders);
  const handed = tenders.reduce((s, x) => s + x.amountPaise, 0n);
  const left = totalPaise > handed ? totalPaise - handed : 0n;
  const nonCash = amounts.upi + amounts.card + amounts.other;
  const remainingForUpi =
    totalPaise > amounts.cash + amounts.card + amounts.other
      ? totalPaise - amounts.cash - amounts.card - amounts.other
      : 0n;
  const fill = (m: TenderMode, p: bigint) => setText({ ...text, [m]: p > 0n ? rupees(p) : '' });

  const pay = async () => {
    setBusy(true);
    try {
      await onPay(tenders);
    } catch (e) {
      toast.error(errText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-xl" data-testid="pos-pay">
        <DialogTitle>{t('pos.pay.title')}</DialogTitle>
        <DialogDescription>{t('pos.pay.help')}</DialogDescription>
        <div className="flex items-baseline justify-between">
          <span className="text-fg-muted">{t('pos.pay.due')}</span>
          <span className="text-3xl font-semibold tabular" data-testid="pos-pay-due">
            {money(totalPaise)}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          {TENDER_MODES.map((m) => (
            <div key={m} className="grid grid-cols-[5rem_8rem_1fr] items-center gap-2 text-sm">
              <label htmlFor={`tender-${m}`} className="font-medium">
                {t(dyn(`pos.pay.mode.${m}`))}
              </label>
              <Input
                id={`tender-${m}`}
                inputMode="decimal"
                className="tabular text-right"
                data-testid={`tender-${m}`}
                placeholder="0.00"
                value={text[m]}
                onChange={(e) => setText({ ...text, [m]: e.target.value })}
              />
              {m === 'cash' ? (
                <div className="flex flex-wrap gap-1">
                  {cashSuggestions(
                    totalPaise - nonCash > 0n ? totalPaise - nonCash : totalPaise,
                  ).map((s) => (
                    <Button
                      key={String(s)}
                      type="button"
                      variant="outline"
                      data-testid={`cash-quick-${Number(s) / 100}`}
                      onClick={() => fill('cash', s)}
                    >
                      {Number(s) / 100}
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <Input
                    placeholder={
                      m === 'upi'
                        ? t('pos.pay.upiRef')
                        : m === 'card'
                          ? t('pos.pay.cardRef')
                          : t('pos.pay.otherRef')
                    }
                    aria-label={t('pos.pay.reference')}
                    data-testid={`ref-${m}`}
                    value={ref[m]}
                    onChange={(e) => setRef({ ...ref, [m]: e.target.value })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    data-testid={`rest-${m}`}
                    onClick={() => fill(m, remainingForUpi)}
                  >
                    {t('pos.pay.rest')}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>

        {upiId ? (
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              data-testid="pos-pay-qr"
              onClick={() => setShowQr(!showQr)}
            >
              {showQr ? t('pos.pay.hideQr') : t('pos.pay.showQr')}
            </Button>
            {showQr && remainingForUpi > 0n && (
              <UpiQr
                size={180}
                label={t('pos.pay.qrLabel')}
                link={upiLink({
                  upiId,
                  payee,
                  amountPaise: amounts.upi > 0n ? amounts.upi : remainingForUpi,
                  note: t('pos.pay.upiNote'),
                })}
              />
            )}
          </div>
        ) : (
          <p className="text-xs text-fg-muted">{t('pos.pay.noUpi')}</p>
        )}

        <div
          className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 text-sm"
          data-testid="pos-pay-summary"
        >
          <span className="text-fg-muted">{t('pos.pay.received')}</span>
          <span className="text-right tabular">{money(handed)}</span>
          {left > 0n ? (
            <>
              <span className="text-fg-muted">{t('pos.pay.left')}</span>
              <span
                className="text-right text-lg font-semibold tabular text-danger"
                data-testid="pos-pay-left"
              >
                {money(left)}
              </span>
            </>
          ) : (
            <>
              <span className="text-fg-muted">{t('pos.pay.change')}</span>
              <span
                className="text-right text-lg font-semibold tabular"
                data-testid="pos-pay-change"
              >
                {money(settled.changePaise)}
              </span>
            </>
          )}
          {settled.errors.includes('over_noncash') && (
            <p className="col-span-2 text-danger" role="alert" data-testid="pos-pay-over">
              {t('pos.pay.over')}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('pos.cancel')}
          </Button>
          <Button
            data-testid="pos-pay-confirm"
            disabled={busy || bad || !settled.ok}
            onClick={() => void pay()}
          >
            {t('pos.pay.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ returns */

export function ReturnDialog({
  counter,
  shift,
  inventoryEnabled,
  today,
  initialCode,
  onDone,
  onClose,
}: {
  counter: Counter;
  shift: Shift;
  inventoryEnabled: boolean;
  today: string;
  initialCode: string;
  onDone: (creditNoteId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [code, setCode] = useState(initialCode);
  const [bill, setBill] = useState<BillLookup | null | 'none'>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [mode, setMode] = useState<TenderMode>('cash');
  const [busy, setBusy] = useState(false);
  void counter;

  const find = async (text: string) => {
    if (!database || !ctx) return;
    const number = parseBillCode(text);
    if (!number) return;
    const found = await new PosRepo(database).findBill(ctx, number);
    setBill(found ?? 'none');
    setQty({});
  };
  // a code handed in by a scan on the counter screen is looked up straight away
  const [started, setStarted] = useState(false);
  if (!started && initialCode) {
    setStarted(true);
    void find(initialCode);
  }

  const wants =
    bill && bill !== 'none'
      ? bill.lines
          .map((l) => ({
            lineNo: Number(l['line_no']),
            qtyMicros: BigInt(parseQtyMicros(qty[Number(l['line_no'])] ?? '') ?? 0),
          }))
          .filter((w) => w.qtyMicros > 0n)
      : [];

  const confirm = async () => {
    if (!database || !ctx || !bill || bill === 'none') return;
    setBusy(true);
    try {
      const r = await new PosRepo(database).sellReturn(ctx, {
        shiftId: shift.id,
        sourceDocumentId: String(bill.document['id']),
        lines: wants,
        refundMode: mode,
        date: today,
        inventoryEnabled,
      });
      toast.success(t('pos.return.done', { amount: money(r.refundPaise) }));
      onDone(String(r.creditNote['id']));
    } catch (e) {
      toast.error(errText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="pos-return">
        <DialogTitle>{t('pos.return.title')}</DialogTitle>
        <DialogDescription>{t('pos.return.help')}</DialogDescription>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void find(code);
          }}
        >
          <Input
            value={code}
            placeholder={t('pos.return.scan')}
            aria-label={t('pos.return.scan')}
            data-testid="pos-return-code"
            onChange={(e) => setCode(e.target.value)}
          />
          <Button type="submit" data-testid="pos-return-find">
            {t('pos.return.find')}
          </Button>
        </form>
        {bill === 'none' && (
          <p className="text-sm text-danger" role="alert" data-testid="pos-return-none">
            {t('pos.return.none')}
          </p>
        )}
        {bill && bill !== 'none' && (
          <>
            <p className="text-sm">
              <span className="font-medium">{String(bill.document['number'])}</span>{' '}
              <span className="text-fg-muted">{String(bill.document['date'])}</span>{' '}
              <span className="tabular">{money(Number(bill.document['total_paise']))}</span>
              {bill.fullyReturned && <Badge className="ml-2">{t('pos.return.fully')}</Badge>}
            </p>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-fg-muted">
                <tr>
                  <th className="p-1 font-medium">{t('pos.cart.item')}</th>
                  <th className="p-1 text-right font-medium">{t('pos.return.sold')}</th>
                  <th className="p-1 text-right font-medium">{t('pos.return.left')}</th>
                  <th className="p-1 text-right font-medium">{t('pos.return.back')}</th>
                </tr>
              </thead>
              <tbody>
                {bill.lines.map((l) => {
                  const no = Number(l['line_no']);
                  const left = BigInt(Number(l['qty_micros'])) - l.returnedMicros;
                  return (
                    <tr key={no} className="border-t border-border" data-testid="pos-return-line">
                      <td className="p-1">{String(l['description'])}</td>
                      <td className="tabular p-1 text-right">
                        {qtyLabel(BigInt(Number(l['qty_micros'])))}
                      </td>
                      <td className="tabular p-1 text-right">{qtyLabel(left)}</td>
                      <td className="p-1 text-right">
                        <Input
                          className="ml-auto w-20 text-right tabular"
                          inputMode="decimal"
                          disabled={left <= 0n}
                          aria-label={t('pos.return.back')}
                          data-testid={`pos-return-qty-${no}`}
                          value={qty[no] ?? ''}
                          onChange={(e) => setQty({ ...qty, [no]: e.target.value })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <fieldset className="flex flex-wrap items-center gap-3 text-sm">
              <legend className="pb-1 text-fg-muted">{t('pos.return.refundBy')}</legend>
              {(['cash', 'upi', 'card', 'other'] as const).map((m) => (
                <label key={m} className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="refund"
                    data-testid={`pos-refund-${m}`}
                    checked={mode === m}
                    onChange={() => setMode(m)}
                  />
                  {t(dyn(`pos.pay.mode.${m}`))}
                </label>
              ))}
            </fieldset>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('pos.cancel')}
          </Button>
          <Button
            data-testid="pos-return-confirm"
            disabled={busy || wants.length === 0 || !bill || bill === 'none'}
            onClick={() => void confirm()}
          >
            {t('pos.return.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ shifts */

/** Open the shift: the float in the drawer to start with. */
export function OpenShiftCard({
  counter,
  onOpen,
}: {
  counter: Counter;
  onOpen: (floatPaise: bigint) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [float, setFloat] = useState('');
  const [busy, setBusy] = useState(false);
  const paise = parsePaise(float);
  return (
    <form
      className="mx-auto mt-10 flex max-w-sm flex-col gap-3 rounded-lg border border-border p-5"
      data-testid="pos-open-shift"
      onSubmit={(e) => {
        e.preventDefault();
        if (paise === null) return;
        setBusy(true);
        void onOpen(paise).finally(() => setBusy(false));
      }}
    >
      <h2 className="text-lg font-semibold">
        {t('pos.shift.openTitle', { counter: counter.name })}
      </h2>
      <p className="text-sm text-fg-muted">{t('pos.shift.openHelp')}</p>
      <label className="flex flex-col gap-1 text-sm">
        {t('pos.shift.float')}
        <Input
          ref={focusOnMount}
          inputMode="decimal"
          className="tabular"
          placeholder="0.00"
          data-testid="pos-float"
          value={float}
          onChange={(e) => setFloat(e.target.value)}
        />
      </label>
      <Button type="submit" data-testid="pos-open" disabled={busy || paise === null}>
        {t('pos.shift.open')}
      </Button>
    </form>
  );
}

export function CashDialog({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [kind, setKind] = useState<'in' | 'out'>('out');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const paise = parsePaise(amount);
  const save = async () => {
    if (!database || !ctx || !paise) return;
    setBusy(true);
    try {
      await new PosRepo(database).cashMovement(ctx, {
        shiftId: shift.id,
        kind,
        amountPaise: paise,
        reason,
      });
      toast.success(t('pos.cash.saved'));
      onClose();
    } catch (e) {
      toast.error(errText(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm" data-testid="pos-cash">
        <DialogTitle>{t('pos.cash.title')}</DialogTitle>
        <DialogDescription>{t('pos.cash.help')}</DialogDescription>
        <div className="flex gap-4 text-sm">
          {(['out', 'in'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1">
              <input
                type="radio"
                name="cash-kind"
                data-testid={`cash-${k}`}
                checked={kind === k}
                onChange={() => setKind(k)}
              />
              {t(`pos.cash.${k}`)}
            </label>
          ))}
        </div>
        <Input
          inputMode="decimal"
          placeholder={t('pos.cash.amount')}
          aria-label={t('pos.cash.amount')}
          className="tabular"
          data-testid="cash-amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Input
          placeholder={t('pos.cash.reason')}
          aria-label={t('pos.cash.reason')}
          data-testid="cash-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('pos.cancel')}
          </Button>
          <Button
            data-testid="cash-save"
            disabled={busy || !paise || !reason.trim()}
            onClick={() => void save()}
          >
            {t('pos.cash.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The Z report as a person reads it: sales and returns, takings by mode, tax, and the drawer. */
export function ZReportView({ z }: { z: ZReport }) {
  const { t } = useTranslation();
  const row = (label: string, value: bigint, id?: string, strong = false) => (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd
        className={`text-right tabular ${strong ? 'font-semibold' : ''}`}
        {...(id ? { 'data-testid': id } : {})}
      >
        {money(value)}
      </dd>
    </>
  );
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm" data-testid="pos-z">
      <dt className="text-fg-muted">{t('pos.z.sales')}</dt>
      <dd className="text-right tabular" data-testid="z-sales-count">
        {z.salesCount}
      </dd>
      {row(t('pos.z.salesValue'), z.salesPaise, 'z-sales')}
      <dt className="text-fg-muted">{t('pos.z.returns')}</dt>
      <dd className="text-right tabular" data-testid="z-returns-count">
        {z.returnsCount}
      </dd>
      {row(t('pos.z.returnsValue'), z.returnsPaise, 'z-returns')}
      {row(t('pos.z.net'), z.netPaise, 'z-net', true)}
      {TENDER_MODES.filter((m) => z.byMode[m] !== 0n).map((m) => (
        <div key={m} className="contents" data-testid={`z-mode-${m}`}>
          {row(t(dyn(`pos.pay.mode.${m}`)), z.byMode[m])}
        </div>
      ))}
      {row(t('pos.z.taxable'), z.tax.taxablePaise)}
      {z.tax.cgstPaise !== 0n && row('CGST', z.tax.cgstPaise)}
      {z.tax.sgstPaise !== 0n && row('SGST', z.tax.sgstPaise)}
      {z.tax.igstPaise !== 0n && row('IGST', z.tax.igstPaise)}
      {z.tax.cessPaise !== 0n && row('Cess', z.tax.cessPaise)}
      {row(t('pos.z.float'), z.drawer.floatPaise)}
      {row(t('pos.z.cashSales'), z.drawer.cashSalesPaise)}
      {row(t('pos.z.cashRefunds'), z.drawer.cashRefundsPaise)}
      {row(t('pos.z.cashIn'), z.drawer.cashInPaise)}
      {row(t('pos.z.cashOut'), z.drawer.cashOutPaise)}
      {row(t('pos.z.expected'), z.drawer.expectedPaise, 'z-expected', true)}
    </dl>
  );
}

/**
 * Count the drawer and close the shift. The count is typed before the expected figure is shown, so the count is
 * honest; the variance is recorded with the shift and the Z report stays on screen to print.
 */
export function CloseShiftDialog({
  shift,
  onPrint,
  onClosed,
  onClose,
}: {
  shift: Shift;
  onPrint: (report: ShiftReport, countedPaise: bigint | null) => void;
  onClosed: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const report = useLiveQuery<ShiftReport>({
    tables: ['pos_bills', 'pos_cash_movements', 'documents', 'pos_shifts'],
    key: ['pos-report', shift.id],
    fn: (d, c) => new PosRepo(d).shiftReport(c, shift.id),
  }).data;
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{
    variance: bigint;
    status: 'balanced' | 'short' | 'over';
    counted: bigint;
  } | null>(null);
  const paise = counted.trim() === '' ? null : parsePaise(counted);
  const preview =
    report && paise !== null ? closeVariance(report.z.drawer.expectedPaise, paise) : null;

  const close = async () => {
    if (!database || !ctx || paise === null) return;
    setBusy(true);
    try {
      const r = await new PosRepo(database).closeShift(ctx, {
        shiftId: shift.id,
        countedPaise: paise,
        note,
      });
      setDone({ variance: r.variancePaise, status: r.status, counted: paise });
      onClosed();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg" data-testid="pos-close">
        <DialogTitle>{done ? t('pos.close.closedTitle') : t('pos.close.title')}</DialogTitle>
        <DialogDescription>
          {done ? t('pos.close.closedHelp') : t('pos.close.help')}
        </DialogDescription>
        {!done && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              {t('pos.close.counted')}
              <Input
                inputMode="decimal"
                className="tabular"
                placeholder="0.00"
                data-testid="close-counted"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
              />
            </label>
            {preview && (
              <p className="text-sm" data-testid="close-preview" data-status={preview.status}>
                {t(`pos.close.${preview.status}`, {
                  amount: money(
                    preview.variancePaise < 0n ? -preview.variancePaise : preview.variancePaise,
                  ),
                })}
              </p>
            )}
            <Input
              placeholder={t('pos.close.note')}
              aria-label={t('pos.close.note')}
              data-testid="close-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </>
        )}
        {done && (
          <p className="text-sm" data-testid="close-result" data-status={done.status}>
            {t(`pos.close.${done.status}`, {
              amount: money(done.variance < 0n ? -done.variance : done.variance),
            })}
          </p>
        )}
        {report && (done || preview) && <ZReportView z={report.z} />}
        <div className="flex justify-end gap-2">
          {report && (
            <Button
              variant="outline"
              data-testid="close-print"
              onClick={() => onPrint(report, done?.counted ?? paise)}
            >
              {t('pos.close.print')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {done ? t('pos.close.done') : t('pos.cancel')}
          </Button>
          {!done && (
            <Button
              data-testid="close-confirm"
              disabled={busy || paise === null}
              onClick={() => void close()}
            >
              {t('pos.close.confirm')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ held bills */

export function RecallDialog({
  held,
  onRecall,
  onDrop,
  onClose,
}: {
  held: HeldBill[];
  onRecall: (h: HeldBill) => void;
  onDrop: (h: HeldBill) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="pos-recall">
        <DialogTitle>{t('pos.recall.title')}</DialogTitle>
        <DialogDescription>{t('pos.recall.help')}</DialogDescription>
        {held.length === 0 && <p className="text-sm text-fg-muted">{t('pos.recall.none')}</p>}
        <ul className="flex flex-col gap-2">
          {held.map((h) => (
            <li
              key={h.id}
              className="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
              data-testid="pos-held"
            >
              <span className="min-w-0 flex-1 truncate">
                {h.label || t('pos.recall.unnamed')} · {h.lines.length} {t('pos.recall.lines')}
              </span>
              <span className="tabular">{money(h.totalPaise)}</span>
              <Button variant="outline" data-testid="pos-recall-one" onClick={() => onRecall(h)}>
                {t('pos.recall.take')}
              </Button>
              <Button variant="ghost" onClick={() => onDrop(h)}>
                {t('pos.recall.drop')}
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ settings */

export function PosSettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: PosSettings;
  onSave: (s: PosSettings) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [s, setS] = useState({ ...settings, maxText: String(settings.maxDiscountBp / 100) });
  const bp = Math.round(Number(s.maxText) * 100);
  const valid = Number.isFinite(bp) && bp >= 0 && bp <= 10_000;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="pos-settings">
        <DialogTitle>{t('pos.settings.title')}</DialogTitle>
        <DialogDescription>{t('pos.settings.help')}</DialogDescription>
        <label className="flex flex-col gap-1 text-sm">
          {t('pos.settings.maxDiscount')}
          <Input
            inputMode="decimal"
            className="tabular"
            data-testid="set-max-discount"
            value={s.maxText}
            onChange={(e) => setS({ ...s, maxText: e.target.value })}
          />
          <span className="text-xs text-fg-muted">{t('pos.settings.maxDiscountHelp')}</span>
        </label>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex flex-col gap-1">
            {t('pos.settings.prefix')}
            <Input
              data-testid="set-prefix"
              value={s.wedgePrefix}
              onChange={(e) => setS({ ...s, wedgePrefix: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t('pos.settings.suffix')}
            <select
              className="h-9 rounded-md border border-border bg-bg px-2"
              data-testid="set-suffix"
              value={s.wedgeSuffix}
              onChange={(e) =>
                setS({ ...s, wedgeSuffix: e.target.value as PosSettings['wedgeSuffix'] })
              }
            >
              <option value="Enter">{KEY_ENTER}</option>
              <option value="Tab">{KEY_TAB}</option>
              <option value="none">{t('pos.settings.noSuffix')}</option>
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="set-bill-qr"
            checked={s.billQr}
            onChange={(e) => setS({ ...s, billQr: e.target.checked })}
          />
          {t('pos.settings.billQr')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="set-drawer"
            checked={s.drawerKick}
            onChange={(e) => setS({ ...s, drawerKick: e.target.checked })}
          />
          {t('pos.settings.drawer')}
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('pos.cancel')}
          </Button>
          <Button
            data-testid="set-save"
            disabled={!valid}
            onClick={() =>
              void onSave({
                maxDiscountBp: bp,
                wedgePrefix: s.wedgePrefix,
                wedgeSuffix: s.wedgeSuffix,
                billQr: s.billQr,
                drawerKick: s.drawerKick,
              }).then(onClose)
            }
          >
            {t('pos.settings.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

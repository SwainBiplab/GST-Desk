/**
 * "Show QR" (prompt 45): a full-screen dynamic UPI QR for what is owed on an invoice. The customer scans it with
 * any UPI app; this screen asks the cloud every two seconds whether the invoice has been paid, and turns to a
 * large "Paid" when the gateway's webhook has been applied. The QR carries the amount and a reference the
 * gateway matches, so nothing is typed and nothing is reconciled by hand.
 */
import { Button, formatPaise } from '@gst/ui';
import { Check } from '@gst/ui/icons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CloudError, type PaymentRequest } from '@/features/cloud/client';
import { useMessaging, type Messaging } from '@/features/dispatch/use-messaging';
import { UpiQr } from '@/features/mobile/upi-qr';

export const QR_POLL_MS = 2000;

/** The button on the shop's "issued" screen. Not shown when the book has no cloud or no gateway is connected. */
export function ShowQrButton({ documentId }: { documentId: string | null }) {
  const { t } = useTranslation();
  const state = useMessaging();
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const m = state.kind === 'ready' ? state.m : null;
  useEffect(() => {
    if (!m) return;
    void m.client.gatewayStatus(m.orgId, m.businessId).then(
      (s) => setConnected(s.connected && s.active),
      () => undefined,
    );
  }, [m]);
  if (!m || !connected || !documentId) return null;
  return (
    <>
      <Button
        className="col-span-2 min-h-12"
        data-testid="bill-show-qr"
        onClick={() => setOpen(true)}
      >
        {t('mobile.bill.showQr')}
      </Button>
      {open && <ShowQr m={m} documentId={documentId} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ShowQr({
  m,
  documentId,
  onClose,
}: {
  m: Messaging;
  documentId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [req, setReq] = useState<PaymentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void m.client
      .createPaymentRequest(m.orgId, { businessId: m.businessId, documentId, kind: 'qr' })
      .then((r) => live && setReq(r))
      .catch((e: unknown) => live && setError(e instanceof CloudError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [m, documentId]);

  useEffect(() => {
    if (!req || req.status === 'paid') return;
    const timer = setInterval(() => {
      void m.client.paymentRequest(m.orgId, req.id).then(
        (r) => setReq(r),
        () => undefined,
      );
    }, QR_POLL_MS);
    return () => clearInterval(timer);
  }, [m, req]);

  const paid = req?.status === 'paid';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('collect.qr.title')}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-surface p-6 text-center"
      data-testid="show-qr"
    >
      {error && (
        <p className="max-w-sm text-danger" data-testid="show-qr-error">
          {error}
        </p>
      )}
      {!error && !req && <p className="text-fg-muted">{t('collect.qr.making')}</p>}
      {req && !paid && req.url && (
        <>
          <p className="tabular text-3xl font-semibold" data-testid="show-qr-amount">
            {formatPaise(req.amountPaise)}
          </p>
          <UpiQr link={req.url} size={280} label={t('collect.qr.title')} />
          <p className="text-sm text-fg-muted">
            {req.status === 'expired' ? t('collect.qr.expired') : t('collect.qr.scan')}
          </p>
        </>
      )}
      {paid && (
        <div className="flex flex-col items-center gap-3" data-testid="show-qr-paid">
          <Check size={96} className="text-success" aria-hidden />
          <p className="text-4xl font-semibold">{t('collect.qr.paid')}</p>
          <p className="tabular text-xl">{formatPaise(req.paidPaise)}</p>
        </div>
      )}
      <Button
        variant={paid ? 'primary' : 'outline'}
        className="min-h-12"
        data-testid="show-qr-close"
        onClick={onClose}
      >
        {t('collect.qr.close')}
      </Button>
    </div>
  );
}

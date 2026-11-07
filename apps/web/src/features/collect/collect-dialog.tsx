/**
 * Collect online (prompt 45): from an issued invoice, make a payment link (optionally one that takes part
 * payments) or open the full-screen QR. The link is what goes on the PDF and in the share text, and the invoice
 * marks itself paid when the gateway says so.
 */
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenuItem,
  Input,
  Switch,
  formatPaise,
  toast,
} from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ShowQr } from './show-qr';

import { CloudError, type PaymentRequest } from '@/features/cloud/client';
import { useMessaging, type Messaging } from '@/features/dispatch/use-messaging';
import { dyn } from '@/lib/dyn-key';

/** The live link of an invoice, for its PDF and share text. Null when the book has no cloud or none was made. */
export function useLivePayLink(documentId: string | null, enabled: boolean): string | null {
  const state = useMessaging();
  const m = state.kind === 'ready' ? state.m : null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!m || !documentId || !enabled) return;
    let live = true;
    void m.client.paymentRequests(m.orgId, documentId).then(
      (rows) => {
        const link = rows.find(
          (r) => r.kind === 'link' && ['created', 'partial'].includes(r.status),
        );
        if (live) setUrl(link?.url ?? null);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [m?.orgId, m?.client, documentId, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return url;
}

/** The two More-menu items for an issued invoice; nothing when collecting online is not available. */
export function CollectItems({ onOpen }: { onOpen: (kind: 'link' | 'qr') => void }) {
  const { t } = useTranslation();
  const state = useMessaging();
  if (state.kind !== 'ready') return null;
  return (
    <>
      <DropdownMenuItem data-testid="doc-collect" onSelect={() => onOpen('link')}>
        {t('collect.menu.link')}
      </DropdownMenuItem>
      <DropdownMenuItem data-testid="doc-show-qr" onSelect={() => onOpen('qr')}>
        {t('collect.menu.qr')}
      </DropdownMenuItem>
    </>
  );
}

/**
 * The dialogs the items open. They live outside the menu: a menu unmounts its content when it closes, and
 * a dialog inside it would go with it.
 */
export function CollectOverlay({
  open,
  documentId,
  onClose,
}: {
  open: 'link' | 'qr' | null;
  documentId: string;
  onClose: () => void;
}) {
  const state = useMessaging();
  if (state.kind !== 'ready' || !open) return null;
  return open === 'link' ? (
    <CollectDialog m={state.m} documentId={documentId} onClose={onClose} />
  ) : (
    <ShowQr m={state.m} documentId={documentId} onClose={onClose} />
  );
}

function CollectDialog({
  m,
  documentId,
  onClose,
}: {
  m: Messaging;
  documentId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [link, setLink] = useState<PaymentRequest | null>(null);
  const [partial, setPartial] = useState(false);
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void m.client.paymentRequests(m.orgId, documentId).then(
      (rows) => {
        const r = rows.find((x) => x.kind === 'link' && ['created', 'partial'].includes(x.status));
        if (live && r) setLink(r);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [m, documentId]);

  const make = async () => {
    setBusy(true);
    try {
      setLink(
        await m.client.createPaymentRequest(m.orgId, {
          businessId: m.businessId,
          documentId,
          kind: 'link',
          partialAllowed: partial,
          expiresInDays: Math.max(1, Math.min(60, Number(days) || 7)),
        }),
      );
    } catch (e) {
      toast.error(e instanceof CloudError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!link?.url) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success(t('collect.dialog.copied'));
    } catch {
      toast.error(link.url);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="collect-dialog">
        <DialogTitle>{t('collect.dialog.title')}</DialogTitle>
        {link ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              {t('collect.dialog.amount', { amount: formatPaise(link.amountPaise) })} ·{' '}
              <span data-testid="collect-status">{t(dyn(`collect.status.${link.status}`))}</span>
            </p>
            <Input
              readOnly
              value={link.url ?? ''}
              aria-label={t('collect.dialog.link')}
              data-testid="collect-url"
            />
            <div className="flex gap-2">
              <Button data-testid="collect-copy" onClick={() => void copy()}>
                {t('collect.dialog.copy')}
              </Button>
              <Button variant="outline" onClick={onClose}>
                {t('collect.dialog.done')}
              </Button>
            </div>
            <p className="text-xs text-fg-muted">{t('collect.dialog.where')}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex items-center gap-2">
              <Switch
                checked={partial}
                data-testid="collect-partial"
                onCheckedChange={setPartial}
              />
              {t('collect.dialog.partial')}
            </label>
            <label className="flex flex-col gap-1">
              {t('collect.dialog.expires')}
              <Input
                type="number"
                min={1}
                max={60}
                className="w-24"
                value={days}
                data-testid="collect-days"
                onChange={(e) => setDays(e.target.value)}
              />
            </label>
            <Button data-testid="collect-make" disabled={busy} onClick={() => void make()}>
              {t('collect.dialog.make')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

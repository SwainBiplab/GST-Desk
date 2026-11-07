/**
 * Customer links (prompt 47): from an issued document's More menu, or a party's ledger, make a public link
 * that opens that one document or statement, copy it, see how often it was opened, and withdraw it. The
 * dialog lives outside the menu, which unmounts its content when it closes.
 */
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenuItem,
  Input,
  toast,
} from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CloudError, type PortalLink } from '@/features/cloud/client';
import { useMessaging, type Messaging } from '@/features/dispatch/use-messaging';

const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);
const when = (ms: number) => new Date(ms).toLocaleDateString();

export type LinkTarget = { documentId: string } | { partyId: string };

/** The More-menu item for an issued document; nothing when the book has no cloud. */
export function CustomerLinkItem({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const state = useMessaging();
  if (state.kind !== 'ready') return null;
  return (
    <DropdownMenuItem data-testid="doc-customer-link" onSelect={onOpen}>
      {t('portal.menu.document')}
    </DropdownMenuItem>
  );
}

export function CustomerLinkOverlay({
  open,
  target,
  onClose,
}: {
  open: boolean;
  target: LinkTarget;
  onClose: () => void;
}) {
  const state = useMessaging();
  if (state.kind !== 'ready' || !open) return null;
  return <CustomerLinkDialog m={state.m} target={target} onClose={onClose} />;
}

/** On a party's ledger: a button that opens the dialog for the party's statement. */
export function StatementLinkButton({ partyId }: { partyId: string }) {
  const { t } = useTranslation();
  const state = useMessaging();
  const [open, setOpen] = useState(false);
  if (state.kind !== 'ready') return null;
  return (
    <>
      <Button variant="outline" data-testid="statement-link" onClick={() => setOpen(true)}>
        {t('portal.menu.statement')}
      </Button>
      {open && (
        <CustomerLinkDialog m={state.m} target={{ partyId }} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function CustomerLinkDialog({
  m,
  target,
  onClose,
}: {
  m: Messaging;
  target: LinkTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [links, setLinks] = useState<PortalLink[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const statement = 'partyId' in target;

  useEffect(() => {
    let live = true;
    void Promise.all([
      m.client.portalSettings(m.orgId, m.businessId),
      m.client.portalLinks(m.orgId, m.businessId, target),
    ]).then(
      ([s, rows]) => {
        if (!live) return;
        setEnabled(s.enabled && (!statement || s.statements));
        setDays((d) => d || String(s.linkDays));
        setLinks(rows.filter((r) => r.status === 'live'));
      },
      (e: unknown) => live && toast.error(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [m, target, statement, version]);

  const make = async () => {
    setBusy(true);
    try {
      const made = await m.client.createPortalLink(m.orgId, {
        businessId: m.businessId,
        ...target,
        ...(Number(days) > 0 ? { days: Math.min(730, Number(days)) } : {}),
      });
      setFresh(made.url);
      toast.success(t('portal.dialog.made'));
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('portal.dialog.copied'));
    } catch {
      /* no clipboard: the address is on the screen to select */
    }
  };
  const revoke = async (id: string) => {
    try {
      await m.client.revokePortalLink(m.orgId, id);
      toast.success(t('portal.dialog.revoked'));
      if (links.find((l) => l.id === id)?.url === fresh) setFresh(null);
      setVersion((v) => v + 1);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="customer-link-dialog" className="max-w-lg">
        <DialogTitle>
          {statement ? t('portal.dialog.statementTitle') : t('portal.dialog.title')}
        </DialogTitle>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-fg-muted">{t('portal.dialog.help')}</p>
          {enabled === false && (
            <p className="text-danger" data-testid="customer-link-off">
              {t('portal.dialog.off')}
            </p>
          )}
          {enabled && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                {t('portal.dialog.days')}
                <Input
                  type="number"
                  min={1}
                  max={730}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  className="w-28"
                  data-testid="customer-link-days"
                />
              </label>
              <Button onClick={() => void make()} disabled={busy} data-testid="customer-link-make">
                {t('portal.dialog.make')}
              </Button>
            </div>
          )}
          {fresh && (
            <div
              className="flex flex-col gap-2 rounded border border-border p-2"
              data-testid="customer-link-fresh"
            >
              <code className="break-all text-xs" data-testid="customer-link-url">
                {fresh}
              </code>
              <div>
                <Button onClick={() => void copy(fresh)} data-testid="customer-link-copy">
                  {t('portal.dialog.copy')}
                </Button>
              </div>
            </div>
          )}
          <h3 className="font-medium">{t('portal.dialog.live')}</h3>
          {links.length === 0 && <p className="text-fg-muted">{t('portal.dialog.none')}</p>}
          <ul className="flex flex-col gap-2">
            {links.map((l) => (
              <li
                key={l.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="customer-link-row"
              >
                <Badge tone="info">{t('portal.dialog.views', { count: l.views })}</Badge>
                <span className="text-fg-muted">
                  {t('portal.dialog.expires', { date: when(l.expiresAt) })}
                </span>
                {l.url ? (
                  <Button variant="outline" onClick={() => void copy(l.url!)}>
                    {t('portal.dialog.copy')}
                  </Button>
                ) : (
                  <span className="text-xs text-fg-muted">{t('portal.dialog.noUrl')}</span>
                )}
                <Button
                  variant="ghost"
                  onClick={() => void revoke(l.id)}
                  data-testid="customer-link-revoke"
                >
                  {t('portal.dialog.revoke')}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              {t('portal.dialog.done')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

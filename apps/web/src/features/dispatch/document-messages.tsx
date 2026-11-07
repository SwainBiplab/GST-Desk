/**
 * Messaging next to a document or a party (prompt 44): "Send by message" and "Repeat this invoice" for the
 * document's More menu, and the per-channel consent a party has given. Each needs a server-known business
 * (`useMessaging`); without one the items are not offered and the share sheet stays.
 */
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenuItem,
  Input,
  Switch,
  toast,
} from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MessageLog } from './message-log';
import { useMessaging } from './use-messaging';

import { CloudError, type MessageKind } from '@/features/cloud/client';
import { dyn } from '@/lib/dyn-key';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const RECURRENCES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;

/** Menu items for an issued document. Renders nothing when messaging is not available for this book. */
export function DocumentMessageItems({
  documentId,
  kind,
  name,
  start,
  canRepeat,
}: {
  documentId: string;
  kind: MessageKind;
  name: string;
  start: string;
  canRepeat: boolean;
}) {
  const { t } = useTranslation();
  const state = useMessaging();
  const [repeat, setRepeat] = useState(false);
  if (state.kind !== 'ready') return null;
  const { m } = state;
  const send = async () => {
    try {
      const r = await m.client.sendMessage(m.orgId, { businessId: m.businessId, kind, documentId });
      toast.success(
        t(dyn(`dispatch.document.queued_${r.approval === 'auto' ? 'auto' : 'approval'}`)),
      );
    } catch (e) {
      toast.error(e instanceof CloudError ? e.message : errText(e));
    }
  };
  return (
    <>
      <DropdownMenuItem data-testid="doc-send-message" onSelect={() => void send()}>
        {t('dispatch.document.send')}
      </DropdownMenuItem>
      {canRepeat && (
        <DropdownMenuItem data-testid="doc-repeat" onSelect={() => setRepeat(true)}>
          {t('dispatch.document.repeat')}
        </DropdownMenuItem>
      )}
      {repeat && (
        <RepeatDialog
          m={m}
          documentId={documentId}
          name={name}
          start={start}
          onClose={() => setRepeat(false)}
        />
      )}
    </>
  );
}

function RepeatDialog({
  m,
  documentId,
  name,
  start,
  onClose,
}: {
  m: { client: import('@/features/cloud/client').CloudClient; orgId: string; businessId: string };
  documentId: string;
  name: string;
  start: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(name);
  const [frequency, setFrequency] = useState<(typeof RECURRENCES)[number]>('monthly');
  const [first, setFirst] = useState(start);
  const [send, setSend] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="repeat-dialog">
        <DialogTitle>{t('dispatch.document.repeat')}</DialogTitle>
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            {t('dispatch.document.repeatName')}
            <Input
              value={label}
              data-testid="repeat-name"
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t('dispatch.document.repeatEvery')}
            <select
              className="h-9 rounded-md border border-border bg-surface px-2"
              value={frequency}
              data-testid="repeat-frequency"
              onChange={(e) => setFrequency(e.target.value as (typeof RECURRENCES)[number])}
            >
              {RECURRENCES.map((f) => (
                <option key={f} value={f}>
                  {t(dyn(`dispatch.document.freq.${f}`))}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            {t('dispatch.document.repeatStart')}
            <Input
              type="date"
              value={first}
              data-testid="repeat-start"
              onChange={(e) => setFirst(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={send} data-testid="repeat-send" onCheckedChange={setSend} />
            {t('dispatch.document.repeatSend')}
          </label>
          <Button
            data-testid="repeat-save"
            disabled={busy || !label.trim() || !first}
            onClick={async () => {
              setBusy(true);
              try {
                await m.client.createRecurring(m.orgId, {
                  businessId: m.businessId,
                  name: label.trim(),
                  sourceDocumentId: documentId,
                  frequency,
                  every: 1,
                  dayOfMonth: Number(first.slice(8, 10)) || 1,
                  start: first,
                  dueDays: 0,
                  send,
                });
                toast.success(t('dispatch.document.repeatMade'));
                onClose();
              } catch (e) {
                toast.error(errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('dispatch.document.repeatSave')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What the document has sent, for its History tab. */
export function DocumentMessages({ documentId }: { documentId: string }) {
  return <MessageLog documentId={documentId} />;
}

/** The party's consent per channel, and what has been sent to them (Party 360). */
export function PartyMessaging({ partyId }: { partyId: string }) {
  const { t } = useTranslation();
  const state = useMessaging();
  const m = state.kind === 'ready' ? state.m : null;
  const [consent, setConsent] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!m) return;
    void m.client.consent(m.orgId, partyId).then(setConsent, () => undefined);
  }, [m?.orgId, m?.client, partyId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return null;
  const toggle = async (channel: 'whatsapp' | 'email', on: boolean) => {
    const status = on ? 'opted_in' : 'opted_out';
    try {
      await m.client.setConsent(m.orgId, { partyId, channel, status });
      setConsent((c) => ({ ...c, [channel]: status }));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="party-messaging">
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="pb-1 font-medium">{t('dispatch.consent.title')}</legend>
        {(['whatsapp', 'email'] as const).map((ch) => (
          <label key={ch} className="flex items-center gap-2">
            <Switch
              data-testid={`consent-${ch}`}
              checked={ch === 'email' ? consent[ch] !== 'opted_out' : consent[ch] === 'opted_in'}
              onCheckedChange={(v) => void toggle(ch, v)}
            />
            {t(dyn(`dispatch.channel.${ch}`))}
          </label>
        ))}
        <p className="text-xs text-fg-muted">{t('dispatch.consent.help')}</p>
      </fieldset>
      <MessageLog partyId={partyId} />
    </div>
  );
}

/** The messages of a customer or a document with each one's status timeline (prompt 44, FR-152). */
import { Badge } from '@gst/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMessaging } from './use-messaging';

import type { LoggedMessage } from '@/features/cloud/client';
import { dyn } from '@/lib/dyn-key';

const tone = (s: string) =>
  s === 'read' || s === 'delivered' || s === 'opened'
    ? 'success'
    : s === 'failed' || s === 'bounced'
      ? 'danger'
      : s === 'sent'
        ? 'info'
        : 'neutral';

/** How often the log is read again while it is on screen: a status shows within seconds of the webhook. */
export const LOG_POLL_MS = 5_000;

export function MessageLog({ documentId, partyId }: { documentId?: string; partyId?: string }) {
  const { t } = useTranslation();
  const state = useMessaging();
  const [rows, setRows] = useState<LoggedMessage[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const ready = state.kind === 'ready' ? state.m : null;

  const load = useCallback(async () => {
    if (!ready) return;
    try {
      setRows(
        await ready.client.messageLog(ready.orgId, {
          ...(documentId ? { documentId } : {}),
          ...(partyId ? { partyId } : {}),
        }),
      );
    } catch {
      /* offline, or messaging is not part of the plan: the list stays as it was */
    }
  }, [ready?.orgId, ready?.client, documentId, partyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setInterval(() => void load(), LOG_POLL_MS);
    const first = setTimeout(() => void load(), 0);
    return () => {
      clearInterval(timer);
      clearTimeout(first);
    };
  }, [load]);

  if (!ready) return null;
  return (
    <section data-testid="message-log" className="py-2">
      <h3 className="pb-1 text-sm font-medium">{t('dispatch.log.title')}</h3>
      {rows && rows.length === 0 && (
        <p className="text-sm text-fg-muted">{t('dispatch.log.none')}</p>
      )}
      <ul className="divide-y divide-border text-sm">
        {(rows ?? []).map((m) => (
          <li key={m.id} className="py-1" data-testid="message-row">
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left"
              aria-expanded={open === m.id}
              onClick={() => setOpen(open === m.id ? null : m.id)}
            >
              <span className="grow">
                {t(dyn(`dispatch.kind.${m.kind}`))} · {t(dyn(`dispatch.channel.${m.channel}`))}
                <span className="text-fg-muted"> · {m.to_address}</span>
              </span>
              <Badge tone={tone(m.status)} data-testid="message-status">
                {m.approval === 'pending'
                  ? t('dispatch.status.waiting')
                  : t(dyn(`dispatch.status.${m.status}`))}
              </Badge>
            </button>
            {open === m.id && (
              <ol className="pl-4 pt-1 text-xs text-fg-muted" data-testid="message-timeline">
                {m.timeline.map((e, i) => (
                  <li key={i}>
                    {new Date(e.at).toLocaleString('en-IN')} ·{' '}
                    {t(dyn(`dispatch.status.${e.status}`))}
                    {e.detail ? ` · ${e.detail}` : ''}
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

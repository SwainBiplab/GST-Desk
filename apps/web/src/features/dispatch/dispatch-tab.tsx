/**
 * Settings, Messages (prompt 44): what is waiting for approval, when messages are made (on issue, on payment,
 * reminders by ageing rules), the templates in six languages with Meta's approval, recurring invoices, and the
 * log. All of it is the cloud tier's; a free book keeps the share sheet.
 */
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  toast,
} from '@gst/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MessageLog } from './message-log';
import { useMessaging, type Messaging } from './use-messaging';

import {
  CloudError,
  type DispatchSettings,
  type MessageKind,
  type MessageTemplate,
  type MessagingStatus,
  type OutboxMessage,
  type RecurringInvoice,
} from '@/features/cloud/client';
import { dyn } from '@/lib/dyn-key';

const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);
const ISSUE_TYPES = ['tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note'] as const;
const KINDS: MessageKind[] = ['invoice', 'receipt', 'reminder'];
const LANGS = ['en', 'hi', 'ta', 'mr', 'bn', 'gu'] as const;
export const parseOffsets = (text: string): number[] | null => {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  const out = parts.map(Number);
  return out.length > 0 &&
    out.length <= 8 &&
    out.every((n) => Number.isInteger(n) && n >= -30 && n <= 120)
    ? out
    : null;
};
const tplTone = (s: string) =>
  s === 'approved'
    ? 'success'
    : s === 'rejected'
      ? 'danger'
      : s === 'paused'
        ? 'warning'
        : s === 'pending'
          ? 'info'
          : 'neutral';

export function DispatchTab() {
  const { t } = useTranslation();
  const state = useMessaging();
  if (state.kind !== 'ready')
    return (
      <Card className="max-w-3xl p-4" data-testid="dispatch-unavailable">
        <p className="text-sm">{t(dyn(`dispatch.unavailable.${state.kind}`))}</p>
      </Card>
    );
  return <Panels m={state.m} />;
}

function Panels({ m }: { m: Messaging }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MessagingStatus | null>(null);
  useEffect(() => {
    void m.client
      .messagingStatus(m.orgId)
      .then(setStatus)
      .catch(() => undefined);
  }, [m]);
  return (
    <div className="flex max-w-4xl flex-col gap-4" data-testid="dispatch-tab">
      {status && (
        <Card className="p-4 text-sm" data-testid="dispatch-status">
          {status.enabled
            ? t('dispatch.status.plan', { used: status.used, limit: status.limit })
            : t('dispatch.status.noPlan')}
          <span className="block text-xs text-fg-muted">
            {t('dispatch.status.channels', {
              whatsapp: status.channels.whatsapp ? t('dispatch.on') : t('dispatch.off'),
              email: status.channels.email ? t('dispatch.on') : t('dispatch.off'),
            })}
          </span>
        </Card>
      )}
      <OutboxCard m={m} />
      <RulesCard m={m} />
      <TemplatesCard m={m} />
      <RecurringCard m={m} />
      <Card className="p-4">
        <MessageLog />
      </Card>
    </div>
  );
}

function OutboxCard({ m }: { m: Messaging }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<OutboxMessage[]>([]);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async () => setRows(await m.client.outbox(m.orgId, m.businessId).catch(() => [])),
    [m],
  );
  useEffect(() => {
    const tick = () => void m.client.outbox(m.orgId, m.businessId).then(setRows, () => undefined);
    tick();
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
  }, [m]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(t(dyn(ok)));
      await load();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4" data-testid="dispatch-outbox">
      <h2 className="pb-1 font-medium">{t('dispatch.outbox.title')}</h2>
      <p className="pb-2 text-xs text-fg-muted">{t('dispatch.outbox.help')}</p>
      {rows.length === 0 && (
        <p className="text-sm text-fg-muted" data-testid="outbox-empty">
          {t('dispatch.outbox.empty')}
        </p>
      )}
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-1 py-2" data-testid="outbox-row">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="neutral">{t(dyn(`dispatch.kind.${r.kind}`))}</Badge>
              <span>
                {t(dyn(`dispatch.channel.${r.channel}`))} · {r.to_address}
              </span>
            </div>
            {r.subject && <p className="text-xs text-fg-muted">{r.subject}</p>}
            <p
              className="whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-sm"
              data-testid="outbox-body"
            >
              {r.body}
            </p>
            <div className="flex gap-2">
              <Button
                data-testid="outbox-approve"
                disabled={busy}
                onClick={() =>
                  void act(() => m.client.approveMessage(m.orgId, r.id), 'dispatch.outbox.sent')
                }
              >
                {t('dispatch.outbox.approve')}
              </Button>
              <Button
                variant="secondary"
                data-testid="outbox-edit"
                onClick={() => setEditing({ id: r.id, body: r.body })}
              >
                {t('dispatch.outbox.edit')}
              </Button>
              <Button
                variant="ghost"
                data-testid="outbox-reject"
                disabled={busy}
                onClick={() =>
                  void act(
                    () => m.client.rejectMessage(m.orgId, r.id),
                    'dispatch.outbox.turnedDown',
                  )
                }
              >
                {t('dispatch.outbox.reject')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent data-testid="outbox-editor">
          <DialogTitle>{t('dispatch.outbox.edit')}</DialogTitle>
          {editing && (
            <div className="flex flex-col gap-2">
              <Textarea
                rows={6}
                value={editing.body}
                aria-label={t('dispatch.outbox.text')}
                data-testid="outbox-text"
                onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              />
              <Button
                data-testid="outbox-send-edited"
                disabled={busy || !editing.body.trim()}
                onClick={() =>
                  void act(async () => {
                    await m.client.approveMessage(m.orgId, editing.id, { body: editing.body });
                    setEditing(null);
                  }, 'dispatch.outbox.sent')
                }
              >
                {t('dispatch.outbox.approveEdited')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function RulesCard({ m }: { m: Messaging }) {
  const { t } = useTranslation();
  const [s, setS] = useState<DispatchSettings | null>(null);
  const [offsets, setOffsets] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void m.client
      .dispatchSettings(m.orgId, m.businessId)
      .then((x) => {
        setS(x);
        setOffsets(x.offsets.join(', '));
      })
      .catch(() => undefined);
  }, [m]);
  if (!s) return null;
  const parsed = parseOffsets(offsets);
  const set = (p: Partial<DispatchSettings>) => setS({ ...s, ...p });
  const row = (label: string, id: string, checked: boolean, on: (v: boolean) => void) => (
    <label className="flex items-center gap-2 text-sm" htmlFor={id}>
      <Switch id={id} data-testid={id} checked={checked} onCheckedChange={on} />
      {label}
    </label>
  );
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="dispatch-rules">
      <h2 className="font-medium">{t('dispatch.rules.title')}</h2>
      <fieldset className="flex flex-col gap-1">
        <legend className="pb-1 text-sm text-fg-muted">{t('dispatch.rules.onIssue')}</legend>
        {ISSUE_TYPES.map((x) =>
          row(t(dyn(`docs.types.${x}`)), `rule-issue-${x}`, !!s.onIssue[x], (v) =>
            set({ onIssue: { ...s.onIssue, [x]: v } }),
          ),
        )}
      </fieldset>
      {row(t('dispatch.rules.onPayment'), 'rule-payment', s.onPayment, (v) =>
        set({ onPayment: v }),
      )}
      {row(t('dispatch.rules.reminders'), 'rule-reminders', s.reminders, (v) =>
        set({ reminders: v }),
      )}
      <label className="flex flex-col gap-1 text-sm">
        {t('dispatch.rules.offsets')}
        <Input
          className="w-64"
          value={offsets}
          onChange={(e) => setOffsets(e.target.value)}
          data-testid="rule-offsets"
          aria-invalid={!parsed}
        />
        <span className="text-xs text-fg-muted">{t('dispatch.rules.offsetsHelp')}</span>
      </label>
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex flex-col gap-1">
          {t('dispatch.rules.quietFrom')}
          <Input
            type="time"
            value={s.quietStart}
            data-testid="rule-quiet-start"
            onChange={(e) => set({ quietStart: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          {t('dispatch.rules.quietTo')}
          <Input
            type="time"
            value={s.quietEnd}
            data-testid="rule-quiet-end"
            onChange={(e) => set({ quietEnd: e.target.value })}
          />
        </label>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="pb-1 text-sm text-fg-muted">{t('dispatch.rules.auto')}</legend>
        {KINDS.map((k) =>
          row(t(dyn(`dispatch.kind.${k}`)), `rule-auto-${k}`, !!s.autoSend[k], (v) =>
            set({ autoSend: { ...s.autoSend, [k]: v } }),
          ),
        )}
        <p className="text-xs text-fg-muted">{t('dispatch.rules.autoHelp')}</p>
      </fieldset>
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex flex-col gap-1">
          {t('dispatch.rules.channel')}
          <Select
            value={s.channel}
            onValueChange={(v) => set({ channel: v as DispatchSettings['channel'] })}
          >
            <SelectTrigger className="w-56" data-testid="rule-channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['whatsapp_first', 'email_first', 'whatsapp', 'email'] as const).map((c) => (
                <SelectItem key={c} value={c}>
                  {t(dyn(`dispatch.channelPref.${c}`))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          {t('dispatch.rules.language')}
          <Select value={s.defaultLanguage} onValueChange={(v) => set({ defaultLanguage: v })}>
            <SelectTrigger className="w-40" data-testid="rule-language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGS.map((l) => (
                <SelectItem key={l} value={l}>
                  {t(dyn(`dispatch.lang.${l}`))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      <div>
        <Button
          data-testid="rules-save"
          disabled={busy || !parsed}
          onClick={async () => {
            setBusy(true);
            try {
              await m.client.saveDispatchSettings(m.orgId, m.businessId, {
                ...s,
                offsets: parsed!,
              });
              toast.success(t('dispatch.rules.saved'));
            } catch (e) {
              toast.error(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('dispatch.rules.save')}
        </Button>
      </div>
    </Card>
  );
}

function TemplatesCard({ m }: { m: Messaging }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<MessageTemplate[]>([]);
  const [edit, setEdit] = useState<{
    t: MessageTemplate;
    body: string;
    preview: string;
    problems: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async () => setRows(await m.client.messageTemplates(m.orgId).catch(() => [])),
    [m],
  );
  useEffect(() => {
    void m.client.messageTemplates(m.orgId).then(setRows, () => undefined);
  }, [m]);

  const open = async (tpl: MessageTemplate) => {
    const p = await m.client
      .previewTemplate(m.orgId, tpl.kind, tpl.language, tpl.body)
      .catch(() => ({ text: '', problems: [] }));
    setEdit({ t: tpl, body: tpl.body, preview: p.text, problems: p.problems });
  };
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      toast.success(await fn());
      await load();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4" data-testid="dispatch-templates">
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <h2 className="grow font-medium">{t('dispatch.templates.title')}</h2>
        <Button
          variant="secondary"
          data-testid="templates-submit"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await m.client.submitTemplates(m.orgId);
              return t('dispatch.templates.submitted', { count: r.submitted });
            })
          }
        >
          {t('dispatch.templates.submit')}
        </Button>
        <Button
          variant="outline"
          data-testid="templates-sync"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await m.client.syncTemplates(m.orgId);
              return t('dispatch.templates.synced', { count: r.updated });
            })
          }
        >
          {t('dispatch.templates.sync')}
        </Button>
      </div>
      <p className="pb-2 text-xs text-fg-muted">{t('dispatch.templates.help')}</p>
      {KINDS.map((k) => (
        <div key={k} className="pb-2">
          <h3 className="text-sm font-medium">{t(dyn(`dispatch.kind.${k}`))}</h3>
          <ul className="flex flex-wrap gap-2 pt-1">
            {rows
              .filter((x) => x.kind === k)
              .map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm"
                    data-testid={`template-${k}-${x.language}`}
                    onClick={() => void open(x)}
                  >
                    {t(dyn(`dispatch.lang.${x.language}`))}
                    <Badge tone={tplTone(x.status)}>
                      {t(dyn(`dispatch.templates.status.${x.status}`))}
                    </Badge>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-2xl" data-testid="template-editor">
          <DialogTitle>
            {edit
              ? `${t(dyn(`dispatch.kind.${edit.t.kind}`))} · ${t(dyn(`dispatch.lang.${edit.t.language}`))}`
              : ''}
          </DialogTitle>
          {edit && (
            <div className="flex flex-col gap-2">
              {edit.t.reason && (
                <p className="text-sm text-danger">
                  {t('dispatch.templates.refused', { reason: edit.t.reason })}
                </p>
              )}
              <Textarea
                rows={5}
                value={edit.body}
                aria-label={t('dispatch.outbox.text')}
                data-testid="template-text"
                onChange={async (e) => {
                  const body = e.target.value;
                  setEdit({ ...edit, body });
                  const p = await m.client
                    .previewTemplate(m.orgId, edit.t.kind, edit.t.language, body)
                    .catch(() => null);
                  if (p)
                    setEdit((cur) =>
                      cur ? { ...cur, preview: p.text, problems: p.problems } : cur,
                    );
                }}
              />
              <p
                className="whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-sm"
                data-testid="template-preview"
              >
                {edit.preview}
              </p>
              {edit.problems.length > 0 && (
                <ul className="text-sm text-danger" data-testid="template-problems">
                  {edit.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <Button
                data-testid="template-save"
                disabled={busy || edit.problems.length > 0 || edit.body === edit.t.body}
                onClick={() =>
                  void run(async () => {
                    await m.client.saveMessageTemplate(m.orgId, edit.t.id, edit.body);
                    setEdit(null);
                    return t('dispatch.templates.saved');
                  })
                }
              >
                {t('dispatch.templates.save')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function RecurringCard({ m }: { m: Messaging }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<RecurringInvoice[]>([]);
  const load = useCallback(
    async () => setRows(await m.client.recurringInvoices(m.orgId).catch(() => [])),
    [m],
  );
  useEffect(() => {
    void m.client.recurringInvoices(m.orgId).then(setRows, () => undefined);
  }, [m]);
  return (
    <Card className="p-4" data-testid="dispatch-recurring">
      <h2 className="pb-1 font-medium">{t('dispatch.recurring.title')}</h2>
      <p className="pb-2 text-xs text-fg-muted">{t('dispatch.recurring.help')}</p>
      {rows.length === 0 && <p className="text-sm text-fg-muted">{t('dispatch.recurring.none')}</p>}
      <ul className="divide-y divide-border text-sm">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 py-2"
            data-testid="recurring-row"
          >
            <span className="grow">
              {r.name} · {t(dyn(`dispatch.frequency.${r.frequency}`), { count: r.every })}
              <span className="block text-xs text-fg-muted">
                {r.active
                  ? t('dispatch.recurring.next', { date: r.next_run })
                  : t('dispatch.recurring.paused')}
                {r.last_error ? ` · ${t('dispatch.recurring.failed', { why: r.last_error })}` : ''}
              </span>
            </span>
            <Button
              variant="outline"
              data-testid="recurring-toggle"
              onClick={() =>
                void m.client.changeRecurring(m.orgId, r.id, { active: !r.active }).then(load)
              }
            >
              {r.active ? t('dispatch.recurring.pause') : t('dispatch.recurring.resume')}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

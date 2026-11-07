/**
 * Settings, Collect (prompt 45): connect the business's Razorpay account, see what came in online with the
 * gateway's fee, payouts and whether they add up, and refunds waiting for a second person.
 */
import { PaymentFlowRepo } from '@gst/db';
import { today } from '@gst/domain';
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
  formatPaise,
  toast,
} from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useLiveQuery } from '@/app/db';
import {
  CloudError,
  type GatewayRefund,
  type GatewaySettlement,
  type GatewayStatus,
  type OnlinePayment,
} from '@/features/cloud/client';
import { useMessaging, type Messaging } from '@/features/dispatch/use-messaging';
import { dyn } from '@/lib/dyn-key';

const errText = (e: unknown) =>
  e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e);
const when = (ms: number) => new Date(ms).toLocaleString();

export function CollectTab() {
  const { t } = useTranslation();
  const state = useMessaging();
  if (state.kind !== 'ready')
    return (
      <Card className="max-w-3xl p-4" data-testid="collect-unavailable">
        <p className="text-sm">{t(dyn(`dispatch.unavailable.${state.kind}`))}</p>
      </Card>
    );
  return <Panels m={state.m} />;
}

function Panels({ m }: { m: Messaging }) {
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  return (
    <div className="flex max-w-4xl flex-col gap-4" data-testid="collect-tab">
      <GatewayCard m={m} version={version} onChange={refresh} />
      <OnlineCard m={m} version={version} onChange={refresh} />
      <PayoutsCard m={m} />
      <RefundsCard m={m} version={version} onChange={refresh} />
    </div>
  );
}

function GatewayCard({
  m,
  version,
  onChange,
}: {
  m: Messaging;
  version: number;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const [st, setSt] = useState<GatewayStatus | null>(null);
  const [form, setForm] = useState({ keyId: '', keySecret: '', webhookSecret: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void m.client.gatewayStatus(m.orgId, m.businessId).then(setSt, () => undefined);
  }, [m, version]);
  if (!st) return null;
  const base = new URL(m.client.baseUrl).origin;
  const hook = st.webhookPath ? `${base}${st.webhookPath}` : null;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(t(dyn(ok)));
      setForm({ keyId: '', keySecret: '', webhookSecret: '' });
      onChange();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="collect-gateway">
      <h2 className="font-medium">{t('collect.gateway.title')}</h2>
      {!st.configured && <p className="text-sm text-danger">{t('collect.gateway.noKey')}</p>}
      {st.connected && st.active ? (
        <div className="flex flex-col gap-1 text-sm" data-testid="collect-connected">
          <p>
            {t('collect.gateway.connected', { key: st.keyId ?? '' })}{' '}
            <Badge tone={st.mode === 'live' ? 'success' : 'warning'}>
              {t(dyn(`collect.gateway.mode.${st.mode ?? 'test'}`))}
            </Badge>
          </p>
          {st.mode === 'test' && (
            <p className="text-xs text-fg-muted">{t('collect.gateway.testHelp')}</p>
          )}
          {st.lastError ? (
            <p className="text-danger" data-testid="collect-last-error">
              {t('collect.gateway.lastError', { why: st.lastError })}
            </p>
          ) : st.lastOkAt ? (
            <p className="text-xs text-fg-muted">
              {t('collect.gateway.lastOk', { at: when(st.lastOkAt) })}
            </p>
          ) : null}
          {hook && (
            <label className="flex flex-col gap-1">
              {t('collect.gateway.webhook')}
              <Input readOnly value={hook} data-testid="collect-webhook" />
              <span className="text-xs text-fg-muted">{t('collect.gateway.webhookHelp')}</span>
            </label>
          )}
          <div>
            <Button
              variant="outline"
              data-testid="collect-disconnect"
              disabled={busy}
              onClick={() =>
                void run(
                  () => m.client.disconnectGateway(m.orgId, m.businessId),
                  'collect.gateway.disconnected',
                )
              }
            >
              {t('collect.gateway.disconnect')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-fg-muted">{t('collect.gateway.help')}</p>
          {(['keyId', 'keySecret', 'webhookSecret'] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1">
              {t(dyn(`collect.gateway.${k}`))}
              <Input
                type={k === 'keyId' ? 'text' : 'password'}
                autoComplete="off"
                className="max-w-md"
                value={form[k]}
                data-testid={`collect-${k}`}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              />
            </label>
          ))}
          <div>
            <Button
              data-testid="collect-connect"
              disabled={
                busy || !st.configured || !form.keyId || !form.keySecret || !form.webhookSecret
              }
              onClick={() =>
                void run(
                  () => m.client.connectGateway(m.orgId, { businessId: m.businessId, ...form }),
                  'collect.gateway.saved',
                )
              }
            >
              {t('collect.gateway.connect')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

const TONE: Record<string, 'success' | 'danger' | 'info'> = {
  matched: 'success',
  unmatched: 'danger',
  processing: 'info',
  received: 'info',
};

function OnlineCard({
  m,
  version,
  onChange,
}: {
  m: Messaging;
  version: number;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<OnlinePayment[]>([]);
  const [refund, setRefund] = useState<OnlinePayment | null>(null);
  useEffect(() => {
    void m.client.onlinePayments(m.orgId, m.businessId).then(setRows, () => undefined);
  }, [m, version]);
  return (
    <Card className="p-4" data-testid="collect-online">
      <h2 className="pb-2 font-medium">{t('collect.online.title')}</h2>
      {rows.length === 0 && <p className="text-sm text-fg-muted">{t('collect.online.none')}</p>}
      <ul className="divide-y divide-border text-sm">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 py-2"
            data-testid="online-row"
          >
            <span className="tabular w-28">{formatPaise(r.amountPaise)}</span>
            <Badge tone={TONE[r.status] ?? 'neutral'}>
              {t(dyn(`collect.online.status.${r.status}`))}
            </Badge>
            <span className="grow text-xs text-fg-muted">
              {r.method} · {t('collect.online.fee', { fee: formatPaise(r.feePaise) })} ·{' '}
              {when(r.at)}
              {r.refundedPaise > 0
                ? ` · ${t('collect.online.refunded', { amount: formatPaise(r.refundedPaise) })}`
                : ''}
            </span>
            {r.status === 'matched' && r.refundedPaise < r.amountPaise && (
              <Button variant="outline" data-testid="online-refund" onClick={() => setRefund(r)}>
                {t('collect.online.refund')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {refund && (
        <RefundDialog m={m} payment={refund} onClose={() => setRefund(null)} onDone={onChange} />
      )}
    </Card>
  );
}

function RefundDialog({
  m,
  payment,
  onClose,
  onDone,
}: {
  m: Messaging;
  payment: OnlinePayment;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const iso = today(() => new Date());
  const notes = useLiveQuery<{ id: string; label: string; balance: number }[]>({
    tables: ['documents', 'payments', 'payment_allocations'],
    key: ['refund-notes', payment.partyId, iso],
    enabled: !!payment.partyId,
    fn: async (d, c) =>
      (await new PaymentFlowRepo(d).positions(c, iso)).credits
        .filter(
          (x) => x.partyId === payment.partyId && x.type === 'credit_note' && x.balancePaise > 0n,
        )
        .map((x) => ({ id: x.id, label: x.number ?? x.id, balance: Number(x.balancePaise) })),
  });
  const [noteId, setNoteId] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const note = (notes.data ?? []).find((n) => n.id === noteId);
  const room = payment.amountPaise - payment.refundedPaise;
  const cap = note ? Math.min(room, note.balance) : room;
  const paise = Math.round(Number(amount) * 100);
  const valid = !!note && paise > 0 && paise <= cap;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="refund-dialog">
        <DialogTitle>{t('collect.refund.title')}</DialogTitle>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-fg-muted">{t('collect.refund.help')}</p>
          <label className="flex flex-col gap-1">
            {t('collect.refund.note')}
            <Select
              value={noteId}
              onValueChange={(v) => {
                setNoteId(v);
                const n = (notes.data ?? []).find((x) => x.id === v);
                setAmount(n ? String(Math.min(room, n.balance) / 100) : '');
              }}
            >
              <SelectTrigger data-testid="refund-note">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(notes.data ?? []).map((n) => (
                  <SelectItem
                    key={n.id}
                    value={n.id}
                  >{`${n.label} · ${formatPaise(n.balance)}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {(notes.data ?? []).length === 0 && (
            <p className="text-xs text-danger">{t('collect.refund.noNotes')}</p>
          )}
          <label className="flex flex-col gap-1">
            {t('collect.refund.amount')}
            <Input
              type="number"
              min={0}
              step="0.01"
              className="w-40"
              value={amount}
              data-testid="refund-amount"
              onChange={(e) => setAmount(e.target.value)}
            />
            {note && (
              <span className="text-xs text-fg-muted">
                {t('collect.refund.max', { amount: formatPaise(cap) })}
              </span>
            )}
          </label>
          <Button
            data-testid="refund-send"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await m.client.requestRefund(m.orgId, {
                  businessId: m.businessId,
                  gatewayPaymentId: payment.id,
                  creditNoteId: noteId,
                  amountPaise: paise,
                });
                toast.success(t('collect.refund.asked'));
                onDone();
                onClose();
              } catch (e) {
                toast.error(errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('collect.refund.ask')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PayoutsCard({ m }: { m: Messaging }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<GatewaySettlement[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void m.client.settlements(m.orgId, m.businessId).then(setRows, () => undefined);
  }, [m]);
  return (
    <Card className="p-4" data-testid="collect-payouts">
      <div className="flex items-center gap-2 pb-2">
        <h2 className="grow font-medium">{t('collect.payouts.title')}</h2>
        <Button
          variant="outline"
          data-testid="payouts-sync"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setRows(await m.client.syncSettlements(m.orgId, m.businessId));
            } catch (e) {
              toast.error(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('collect.payouts.sync')}
        </Button>
      </div>
      {rows.length === 0 && <p className="text-sm text-fg-muted">{t('collect.payouts.none')}</p>}
      <ul className="divide-y divide-border text-sm">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 py-2"
            data-testid="payout-row"
          >
            <span className="tabular w-28">{formatPaise(r.amountPaise)}</span>
            <span className="grow text-xs text-fg-muted">
              {r.utr ? `${t('collect.payouts.utr')} ${r.utr} · ` : ''}
              {t('collect.online.fee', { fee: formatPaise(r.feePaise) })} · {when(r.at)}
            </span>
            <Badge tone={r.matched ? 'success' : 'warning'}>
              {r.matched ? t('collect.payouts.matched') : t('collect.payouts.unmatched')}
            </Badge>
          </li>
        ))}
      </ul>
      <p className="pt-2 text-xs text-fg-muted">{t('collect.payouts.help')}</p>
    </Card>
  );
}

function RefundsCard({
  m,
  version,
  onChange,
}: {
  m: Messaging;
  version: number;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<GatewayRefund[]>([]);
  useEffect(() => {
    void m.client.gatewayRefunds(m.orgId, m.businessId).then(setRows, () => undefined);
  }, [m, version]);
  const decide = async (id: string, approve: boolean) => {
    try {
      await m.client.decideRefund(m.orgId, id, approve);
      toast.success(t(approve ? 'collect.refunds.approved' : 'collect.refunds.rejected'));
    } catch (e) {
      toast.error(errText(e));
    }
    onChange();
  };
  if (rows.length === 0) return null;
  return (
    <Card className="p-4" data-testid="collect-refunds">
      <h2 className="pb-2 font-medium">{t('collect.refunds.title')}</h2>
      <ul className="divide-y divide-border text-sm">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 py-2"
            data-testid="refund-row"
          >
            <span className="tabular w-28">{formatPaise(r.amountPaise)}</span>
            <Badge
              tone={
                r.status === 'processed'
                  ? 'success'
                  : r.status === 'failed' || r.status === 'rejected'
                    ? 'danger'
                    : 'info'
              }
            >
              {t(dyn(`collect.refunds.status.${r.status}`))}
            </Badge>
            <span className="grow text-xs text-fg-muted">{r.error ?? when(r.createdAt)}</span>
            {(r.status === 'requested' || r.status === 'failed') && (
              <>
                <Button data-testid="refund-approve" onClick={() => void decide(r.id, true)}>
                  {t('collect.refunds.approve')}
                </Button>
                {r.status === 'requested' && (
                  <Button
                    variant="ghost"
                    data-testid="refund-reject"
                    onClick={() => void decide(r.id, false)}
                  >
                    {t('collect.refunds.reject')}
                  </Button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="pt-2 text-xs text-fg-muted">{t('collect.refunds.help')}</p>
    </Card>
  );
}

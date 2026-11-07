import { PartyRepo, ReminderRepo, getPartyStatement, type Row } from '@gst/db';
import { toDecimalString, type Ageing } from '@gst/domain';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  MoneyText,
  PageHeader,
  StatusPill,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  formatDate,
  formatPaise,
  toast,
} from '@gst/ui';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { downloadText, statementCsv } from './csv';
import { stateName } from './form';
import {
  useDefaultUpi,
  useParty,
  usePartyAccount,
  usePartyDocuments,
  usePartyPayments,
} from './hooks';

import { useAppDb, useLiveQuery } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { PartyMessaging } from '@/features/dispatch/document-messages';
import { usePositions } from '@/features/payments/hooks';
import { PayStatusBadge } from '@/features/payments/status-badge';
import { dyn } from '@/lib/dyn-key';

const BUCKETS = ['current', 'd0_30', 'd31_60', 'd61_90', 'd90plus'] as const;

const toDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

function AgeingStrip({ ageing }: { ageing: Ageing }) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5" data-testid="ageing">
      {BUCKETS.map((b) => (
        <Card key={b} data-testid={`ageing-${b}`} className="p-3">
          <p className="text-xs text-fg-muted">{t(`parties.ageing.${b}`)}</p>
          <MoneyText paise={ageing[b]} className="text-lg font-semibold" />
        </Card>
      ))}
    </div>
  );
}

function LedgerTab({ party }: { party: Row }) {
  const { t } = useTranslation();
  const { business } = useAppDb();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: statement } = useLiveQuery({
    tables: ['parties', 'documents', 'payments'],
    key: ['statement', party['id'], from, to],
    fn: (d, c) =>
      getPartyStatement(d, c, party['id'], { ...(from ? { from } : {}), ...(to ? { to } : {}) }),
  });
  if (!statement) return <p className="text-fg-muted">{t('empty.loading')}</p>;
  const period =
    from || to
      ? `${from ? formatDate(toDate(from)) : '…'} – ${to ? formatDate(toDate(to)) : '…'}`
      : t('parties.ledger.allTime');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {t('parties.ledger.from')}
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="ledger-from"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('parties.ledger.to')}
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="ledger-to"
          />
        </label>
        <Button
          variant="outline"
          data-testid="statement-csv"
          onClick={() =>
            downloadText(
              `statement-${party['name']}.csv`.replace(/[^\w.-]+/g, '_'),
              statementCsv(statement),
            )
          }
        >
          {t('parties.ledger.csv')}
        </Button>
        <Button variant="outline" data-testid="statement-print" onClick={() => window.print()}>
          {t('parties.ledger.print')}
        </Button>
      </div>
      <div className="print-area" data-testid="statement">
        <div className="hidden pb-2 print:block">
          <p className="text-lg font-semibold">{business?.['legal_name']}</p>
          <p>
            {t('parties.ledger.title')}: {party['name']} | {period}
          </p>
        </div>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('parties.ledger.date')}</TableHeaderCell>
              <TableHeaderCell>{t('parties.ledger.ref')}</TableHeaderCell>
              <TableHeaderCell>{t('parties.ledger.description')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('parties.ledger.debit')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('parties.ledger.credit')}</TableHeaderCell>
              <TableHeaderCell className="text-right">
                {t('parties.ledger.balance')}
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {statement.openingBalancePaise !== 0n && (
              <TableRow data-testid="ledger-brought-forward">
                <TableCell colSpan={5}>{t('parties.ledger.broughtForward')}</TableCell>
                <TableCell className="text-right">
                  <MoneyText paise={statement.openingBalancePaise} negativeRed />
                </TableCell>
              </TableRow>
            )}
            {statement.lines.map((l) => (
              <TableRow key={`${l.kind}-${l.id}`} data-testid="ledger-line">
                <TableCell className="tabular">{formatDate(toDate(l.date))}</TableCell>
                <TableCell>{l.ref}</TableCell>
                <TableCell className="capitalize">{l.description}</TableCell>
                <TableCell className="text-right">
                  {l.debitPaise ? <MoneyText paise={l.debitPaise} /> : ''}
                </TableCell>
                <TableCell className="text-right">
                  {l.creditPaise ? <MoneyText paise={l.creditPaise} /> : ''}
                </TableCell>
                <TableCell className="text-right">
                  <MoneyText paise={l.balancePaise} negativeRed />
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="font-semibold" data-testid="ledger-closing">
              <TableCell colSpan={5}>{t('parties.ledger.closing')}</TableCell>
              <TableCell className="text-right">
                <MoneyText paise={statement.closingBalancePaise} negativeRed />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        {statement.lines.length === 0 && (
          <p className="pt-2 text-fg-muted">{t('parties.ledger.empty')}</p>
        )}
      </div>
    </div>
  );
}

function DocumentsTab({ partyId, due }: { partyId: string; due: Map<string, bigint> | undefined }) {
  const { t } = useTranslation();
  const { data } = usePartyDocuments(partyId);
  const positions = usePositions(partyId);
  if (!data) return <p className="text-fg-muted">{t('empty.loading')}</p>;
  if (data.length === 0) return <EmptyState title={t('parties.docs.empty')} />;
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>{t('parties.ledger.ref')}</TableHeaderCell>
          <TableHeaderCell>{t('parties.docs.type')}</TableHeaderCell>
          <TableHeaderCell>{t('parties.ledger.date')}</TableHeaderCell>
          <TableHeaderCell>{t('parties.docs.due')}</TableHeaderCell>
          <TableHeaderCell className="text-right">{t('parties.docs.total')}</TableHeaderCell>
          <TableHeaderCell className="text-right">{t('parties.docs.unpaid')}</TableHeaderCell>
          <TableHeaderCell>{t('parties.docs.status')}</TableHeaderCell>
          <TableHeaderCell>{t('docs.list.payment')}</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {data.map((d) => (
          <TableRow key={d['id']} data-testid="party-document">
            <TableCell>{d['number'] ?? '—'}</TableCell>
            <TableCell className="capitalize">{String(d['type']).replace(/_/g, ' ')}</TableCell>
            <TableCell className="tabular">{formatDate(toDate(d['date']))}</TableCell>
            <TableCell className="tabular">
              {d['due_date'] ? formatDate(toDate(d['due_date'])) : '—'}
            </TableCell>
            <TableCell className="text-right">
              <MoneyText paise={d['total_paise']} />
            </TableCell>
            <TableCell className="text-right">
              {due?.has(d['id']) ? <MoneyText paise={due.get(d['id'])!} negativeRed /> : '—'}
            </TableCell>
            <TableCell>
              <StatusPill status={d['status']} />
            </TableCell>
            <TableCell>
              {d['status'] === 'issued' && <PayStatusBadge position={positions.get(d['id'])} />}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PaymentsTab({ partyId }: { partyId: string }) {
  const { t } = useTranslation();
  const { data } = usePartyPayments(partyId);
  if (!data) return <p className="text-fg-muted">{t('empty.loading')}</p>;
  if (data.length === 0) return <EmptyState title={t('parties.payments.empty')} />;
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableHeaderCell>{t('parties.ledger.date')}</TableHeaderCell>
          <TableHeaderCell>{t('parties.payments.mode')}</TableHeaderCell>
          <TableHeaderCell>{t('parties.ledger.ref')}</TableHeaderCell>
          <TableHeaderCell>{t('parties.payments.direction')}</TableHeaderCell>
          <TableHeaderCell className="text-right">{t('parties.docs.total')}</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {data.map((p) => (
          <TableRow key={p['id']} data-testid="party-payment">
            <TableCell className="tabular">{formatDate(toDate(p['date']))}</TableCell>
            <TableCell className="capitalize">{p['mode']}</TableCell>
            <TableCell>{p['reference'] ?? ''}</TableCell>
            <TableCell>{t(dyn(`parties.payments.${p['direction']}`))}</TableCell>
            <TableCell className="text-right">
              <MoneyText paise={p['amount_paise']} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Reminder history. The send buttons open WhatsApp or the mail app with the message filled in, and log it. */
function RemindersTab({
  party,
  dueText,
  duePaise,
}: {
  party: Row;
  dueText: string;
  duePaise: bigint;
}) {
  const { t } = useTranslation();
  const { database, ctx, business } = useAppDb();
  const { data } = useLiveQuery<Row[]>({
    tables: ['reminders'],
    key: ['reminders', party['id']],
    fn: (d, c) => new ReminderRepo(d).forParty(c, party['id']),
  });
  const message = t('parties.reminders.message', {
    name: party['name'],
    amount: dueText,
    business: business?.['trade_name'] ?? business?.['legal_name'] ?? '',
  });
  const phone = party['phone'] as string | null;

  const log = (channel: string) => {
    if (database && ctx) {
      void new ReminderRepo(database)
        .create(ctx, {
          party_id: party['id'],
          channel,
          message,
          amount_paise: Number(duePaise),
          sent_at: Date.now(),
        })
        .then(() => toast.success(t('parties.reminders.logged')));
    }
  };
  const send = (channel: 'whatsapp' | 'email') => {
    // open first (inside the click) so the browser does not treat it as a blocked popup, then log
    const url =
      channel === 'whatsapp'
        ? `https://wa.me/91${phone}?text=${encodeURIComponent(message)}`
        : `mailto:${party['email'] ?? ''}?subject=${encodeURIComponent(t('parties.reminders.subject'))}&body=${encodeURIComponent(message)}`;
    window.open(url, '_blank', 'noopener');
    log(channel);
  };

  return (
    <div className="flex flex-col gap-3">
      <p
        className="rounded-md border border-border bg-surface-1 p-3 text-sm"
        data-testid="reminder-message"
      >
        {message}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!phone}
          data-testid="remind-whatsapp"
          onClick={() => send('whatsapp')}
        >
          {t('parties.reminders.whatsapp')}
        </Button>
        <Button
          variant="outline"
          disabled={!party['email']}
          data-testid="remind-email"
          onClick={() => send('email')}
        >
          {t('parties.reminders.email')}
        </Button>
        <Button variant="ghost" data-testid="remind-call" onClick={() => log('call')}>
          {t('parties.reminders.logCall')}
        </Button>
      </div>
      <h3 className="font-medium">{t('parties.reminders.history')}</h3>
      {!data || data.length === 0 ? (
        <p className="text-fg-muted">{t('parties.reminders.none')}</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="reminder-history">
          {data.map((r) => (
            <li key={r['id']} className="flex items-center gap-2 text-sm">
              <Badge>{r['channel']}</Badge>
              <span className="tabular">{new Date(r['sent_at']).toLocaleString('en-IN')}</span>
              <span className="text-fg-muted">{formatPaise(r['amount_paise'] ?? 0)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NotesTab({ party }: { party: Row }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [text, setText] = useState<string>(party['notes'] ?? '');
  return (
    <form
      className="flex max-w-xl flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!database || !ctx) return;
        void new PartyRepo(database)
          .update(ctx, party['id'], { notes: text.trim() || null }, party['version'])
          .then(() => toast.success(t('parties.saved')))
          .catch((err: unknown) => toast.error(err instanceof Error ? err.message : String(err)));
      }}
    >
      <Textarea
        aria-label={t('parties.tabs.notes')}
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="notes-text"
      />
      <div>
        <Button type="submit" disabled={text === (party['notes'] ?? '')} data-testid="notes-save">
          {t('parties.form.save')}
        </Button>
      </div>
    </form>
  );
}

/** Party 360: who owes what, since when, and every document and payment behind it. */
export function Party360({ id, shell }: { id: string; shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const { business } = useAppDb();
  const upi = useDefaultUpi();
  const { data: party, isLoading } = useParty(id);
  const { data: account } = usePartyAccount(id);

  if (isLoading || !account) return <p className="text-fg-muted">{t('empty.loading')}</p>;
  if (!party)
    return (
      <EmptyState
        title={t('parties.notFound')}
        action={
          <Button onClick={() => navigate(`/${shell}/parties`)}>{t('parties.p360.back')}</Button>
        }
      />
    );

  const balance = account.balancePaise;
  const limit = BigInt(party['credit_limit_paise'] ?? 0);
  const available = limit > 0n ? limit - (balance > 0n ? balance : 0n) : null;
  const owed = balance < 0n ? -balance : balance;
  const phone = party['phone'] as string | null;
  const bizName = business?.['trade_name'] ?? business?.['legal_name'] ?? '';

  const copyUpi = async () => {
    if (!upi) return toast.info(t('parties.p360.noUpi'));
    const amount = balance > 0n ? `&am=${toDecimalString(balance)}` : '';
    const link = `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(bizName)}${amount}&cu=INR&tn=${encodeURIComponent(`Payment to ${bizName}`)}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t('parties.p360.upiCopied'));
    } catch {
      window.prompt(t('parties.p360.copyUpi'), link);
    }
  };

  const stat = (label: string, value: ReactNode, id: string) => (
    <Card className="p-3" data-testid={id}>
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
    </Card>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="party-360" data-party-id={id}>
      <PageHeader
        title={party['name']}
        description={[party['gstin'], party['phone'], party['city'], stateName(party['state_code'])]
          .filter(Boolean)
          .join(' | ')}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => navigate(`/${shell}/parties`)}
              data-testid="p360-back"
            >
              {t('parties.p360.back')}
            </Button>
            <Button
              variant="outline"
              onClick={() => navigate(`/${shell}/parties`, { edit: id })}
              data-testid="p360-edit"
            >
              {t('parties.p360.edit')}
            </Button>
          </>
        }
      />
      {((party['tags_json'] ?? []) as string[]).length > 0 && (
        <div className="flex gap-1">
          {(party['tags_json'] as string[]).map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
      )}

      <div className="grid gap-2 md:grid-cols-4">
        {stat(
          balance >= 0n ? t('parties.p360.owes') : t('parties.p360.oweThem'),
          <MoneyText paise={owed} data-testid="p360-outstanding-value" />,
          'p360-outstanding',
        )}
        {stat(
          t('parties.p360.overdue'),
          <MoneyText
            paise={account.overduePaise}
            className={account.overduePaise > 0n ? 'text-danger' : ''}
          />,
          'p360-overdue',
        )}
        {stat(
          t('parties.p360.creditAvailable'),
          available === null ? (
            <span className="text-base text-fg-muted">{t('parties.p360.noLimit')}</span>
          ) : (
            <MoneyText paise={available} negativeRed />
          ),
          'p360-credit',
        )}
        {stat(
          t('parties.p360.lastPayment'),
          account.lastPaymentDate ? (
            <span className="tabular text-base">{formatDate(toDate(account.lastPaymentDate))}</span>
          ) : (
            <span className="text-base text-fg-muted">{t('parties.p360.never')}</span>
          ),
          'p360-last-payment',
        )}
      </div>

      <AgeingStrip ageing={account.ageing} />

      <div className="flex flex-wrap gap-2" data-testid="quick-actions">
        <Button onClick={() => navigate(`/${shell}/sell`, { party: id })} data-testid="qa-invoice">
          {t('parties.p360.newInvoice')}
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate(`/${shell}/payments`, { intent: 'receive', party: id })}
          data-testid="qa-receive"
        >
          {t('parties.p360.receive')}
        </Button>
        <Button
          variant="outline"
          disabled={!phone}
          data-testid="qa-whatsapp"
          onClick={() => window.open(`https://wa.me/91${phone}`, '_blank', 'noopener')}
        >
          {t('parties.p360.whatsapp')}
        </Button>
        <Button variant="outline" asChild>
          <a
            href={phone ? `tel:+91${phone}` : undefined}
            aria-disabled={!phone}
            data-testid="qa-call"
          >
            {t('parties.p360.call')}
          </a>
        </Button>
        <Button variant="outline" onClick={() => void copyUpi()} data-testid="qa-upi">
          {t('parties.p360.copyUpi')}
        </Button>
      </div>

      <Tabs defaultValue="ledger">
        <TabsList aria-label={t('parties.tabs.label')}>
          {(['ledger', 'documents', 'payments', 'reminders', 'messages', 'notes'] as const).map(
            (k) => (
              <TabsTrigger key={k} value={k} data-testid={`tab-${k}`}>
                {t(`parties.tabs.${k}`)}
              </TabsTrigger>
            ),
          )}
        </TabsList>
        <TabsContent value="ledger">
          <LedgerTab party={party} />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsTab partyId={id} due={account.documentDue} />
        </TabsContent>
        <TabsContent value="payments">
          <PaymentsTab partyId={id} />
        </TabsContent>
        <TabsContent value="reminders">
          <RemindersTab party={party} dueText={formatPaise(owed)} duePaise={owed} />
        </TabsContent>
        <TabsContent value="messages">
          <PartyMessaging partyId={id} />
        </TabsContent>
        <TabsContent value="notes">
          <NotesTab party={party} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

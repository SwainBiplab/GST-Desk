/**
 * The customer's page (prompt 47): what a public link opens. No sign-in and no local book: the page talks to
 * the cloud API with the token in the address and shows the one invoice (lines, totals, what is paid and
 * owed, a Pay button when the business collects online, the PDF) or the one statement, and a way to ask the
 * business a question. The API is the page's own origin unless the build or the address says otherwise.
 */
import { Button, Card, Input, Textarea, formatPaise, toast } from '@gst/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CloudClient,
  CloudError,
  isAllowedApiUrl,
  readCloudUrl,
  type PortalDocumentPage,
  type PortalPage,
  type PortalStatementPage,
} from '@/features/cloud/client';
import { dyn } from '@/lib/dyn-key';

/** Where the API is for a customer's browser: the address's `api`, the build's, this origin. */
export function portalApiBase(search: string, origin: string, stored: string | null): string {
  const fromSearch = new URLSearchParams(search).get('api');
  if (fromSearch && isAllowedApiUrl(fromSearch)) return fromSearch.replace(/\/$/, '');
  const built = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';
  if (built && isAllowedApiUrl(built)) return built.replace(/\/$/, '');
  if (stored && isAllowedApiUrl(stored)) return stored.replace(/\/$/, '');
  return origin.replace(/\/$/, '');
}

const date = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
};
const money = (p: number) => formatPaise(p);

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; page: PortalPage }
  | { kind: 'gone'; message: string }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

export function PortalPage({ token }: { token: string }) {
  const { t } = useTranslation();
  const [client] = useState(
    () =>
      new CloudClient(
        portalApiBase(
          window.location.search,
          window.location.origin,
          readCloudUrl((k) => {
            try {
              return localStorage.getItem(k);
            } catch {
              return null;
            }
          }) || null,
        ),
      ),
  );
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    void client.portalPage(token).then(
      (page) => live && setState({ kind: 'ready', page }),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof CloudError && e.status === 404) setState({ kind: 'not_found' });
        else if (e instanceof CloudError && e.status === 410)
          setState({ kind: 'gone', message: e.message });
        else setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [client, token, version]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-8" data-testid="portal-page">
      {state.kind === 'loading' && <p className="text-fg-muted">{t('portal.page.loading')}</p>}
      {state.kind === 'not_found' && (
        <Card className="p-6" data-testid="portal-not-found">
          {t('portal.page.notFound')}
        </Card>
      )}
      {state.kind === 'gone' && (
        <Card className="p-6" data-testid="portal-gone">
          {t('portal.page.gone')}
        </Card>
      )}
      {state.kind === 'error' && (
        <Card className="p-6 text-danger" data-testid="portal-error">
          {t('portal.page.error')} {state.message}
        </Card>
      )}
      {state.kind === 'ready' && (
        <>
          <Header business={state.page.business} />
          {state.page.kind === 'document' ? (
            <DocumentView
              page={state.page}
              client={client}
              token={token}
              onPaid={() => setVersion((v) => v + 1)}
            />
          ) : (
            <StatementView page={state.page} />
          )}
          {state.page.questions && <QuestionForm client={client} token={token} />}
          <p className="text-xs text-fg-muted">
            {t('portal.page.footer', { name: state.page.business.name })}{' '}
            {t('portal.page.expires', {
              date: new Date(state.page.expiresAt).toLocaleDateString(),
            })}
          </p>
        </>
      )}
    </main>
  );
}

function Header({ business }: { business: PortalPage['business'] }) {
  const { t } = useTranslation();
  const initials = business.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <header className="flex items-center gap-3" data-testid="portal-business">
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-fg"
      >
        {initials}
      </div>
      <div>
        <h1 className="text-xl font-semibold">{business.name}</h1>
        <p className="text-xs text-fg-muted">
          {business.gstin ? `${t('portal.page.gstin')} ${business.gstin}` : ''}
          {business.address.length ? ` · ${business.address.join(', ')}` : ''}
          {business.phone ? ` · ${business.phone}` : ''}
        </p>
      </div>
    </header>
  );
}

function DocumentView({
  page,
  client,
  token,
  onPaid,
}: {
  page: PortalDocumentPage;
  client: CloudClient;
  token: string;
  onPaid: () => void;
}) {
  const { t } = useTranslation();
  const d = page.document;
  const [paying, setPaying] = useState(false);
  const invoice = d.type === 'tax_invoice' || d.type === 'bill_of_supply';
  const pay = async () => {
    setPaying(true);
    try {
      const r = page.pay.url ? { url: page.pay.url } : await client.portalPay(token);
      window.location.assign(r.url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      onPaid();
    } finally {
      setPaying(false);
    }
  };
  return (
    <Card className="flex flex-col gap-4 p-4 md:p-6" data-testid="portal-document">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">
            {invoice ? t('portal.page.invoice') : t('portal.page.document')}{' '}
            {d.number ? t('portal.page.number', { number: d.number }) : ''}
          </h2>
          <p className="text-sm text-fg-muted">
            {t('portal.page.date')} {date(d.date)}
            {d.dueDate ? ` · ${t('portal.page.due')} ${date(d.dueDate)}` : ''}
          </p>
        </div>
        <span
          className={`rounded px-2 py-1 text-sm font-medium ${
            d.status === 'cancelled'
              ? 'bg-danger/20'
              : d.payStatus === 'paid'
                ? 'bg-success/20'
                : d.payStatus === 'part'
                  ? 'bg-warning/20'
                  : 'bg-surface-2'
          }`}
          data-testid="portal-pay-status"
          data-status={d.status === 'cancelled' ? 'cancelled' : d.payStatus}
        >
          {d.status === 'cancelled'
            ? t('portal.page.status.cancelled')
            : t(dyn(`portal.page.status.${d.payStatus}`))}
        </span>
      </div>
      {d.partyName && (
        <p className="text-sm">
          <span className="text-fg-muted">{t('portal.page.billedTo')}</span> {d.partyName}
        </p>
      )}
      <div className="overflow-auto">
        <table className="w-full text-sm" data-testid="portal-lines">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th className="py-1 pr-2">{t('portal.page.item')}</th>
              <th className="py-1 pr-2">{t('portal.page.hsn')}</th>
              <th className="py-1 pr-2 text-right">{t('portal.page.qty')}</th>
              <th className="py-1 pr-2 text-right">{t('portal.page.rate')}</th>
              <th className="py-1 pr-2 text-right">{t('portal.page.gst')}</th>
              <th className="py-1 text-right">{t('portal.page.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l, i) => (
              <tr key={i} className="border-t border-border" data-testid="portal-line">
                <td className="py-1 pr-2">{l.description}</td>
                <td className="py-1 pr-2">{l.hsn ?? ''}</td>
                <td className="py-1 pr-2 text-right">
                  {l.qty}
                  {l.unit ? ` ${l.unit}` : ''}
                </td>
                <td className="py-1 pr-2 text-right">{money(l.ratePaise)}</td>
                <td className="py-1 pr-2 text-right">
                  {(l.gstRateBp / 100).toFixed(l.gstRateBp % 100 ? 2 : 0)}%
                </td>
                <td className="py-1 text-right">{money(l.totalPaise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-1 text-sm">
        <dt className="text-fg-muted">{t('portal.page.subtotal')}</dt>
        <dd className="text-right">{money(d.taxablePaise)}</dd>
        <dt className="text-fg-muted">{t('portal.page.tax')}</dt>
        <dd className="text-right">{money(d.taxPaise)}</dd>
        {d.roundOffPaise !== 0 && (
          <>
            <dt className="text-fg-muted">{t('portal.page.roundOff')}</dt>
            <dd className="text-right">{money(d.roundOffPaise)}</dd>
          </>
        )}
        <dt className="font-semibold">{t('portal.page.total')}</dt>
        <dd className="text-right font-semibold" data-testid="portal-total">
          {money(d.totalPaise)}
        </dd>
        {d.payStatus !== 'not_payable' && (
          <>
            <dt className="text-fg-muted">{t('portal.page.paid')}</dt>
            <dd className="text-right">{money(d.paidPaise)}</dd>
            <dt className="font-semibold">{t('portal.page.balance')}</dt>
            <dd className="text-right font-semibold" data-testid="portal-balance">
              {money(d.balancePaise)}
            </dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        {page.pay.available && d.balancePaise > 0 && (
          <Button onClick={() => void pay()} disabled={paying} data-testid="portal-pay">
            {paying
              ? t('portal.page.paying')
              : t('portal.page.pay', { amount: money(d.balancePaise) })}
          </Button>
        )}
        <Button asChild variant="outline">
          <a href={client.portalPdfUrl(token)} download data-testid="portal-pdf">
            {t('portal.page.pdf')}
          </a>
        </Button>
      </div>
      {page.pay.available && d.balancePaise > 0 && (
        <p className="text-xs text-fg-muted">{t('portal.page.payHelp')}</p>
      )}
      {(d.terms || d.notes) && (
        <div className="text-xs text-fg-muted">
          {d.terms && (
            <p>
              <span className="font-medium">{t('portal.page.terms')}</span> {d.terms}
            </p>
          )}
          {d.notes && (
            <p>
              <span className="font-medium">{t('portal.page.notes')}</span> {d.notes}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function StatementView({ page }: { page: PortalStatementPage }) {
  const { t } = useTranslation();
  return (
    <Card className="flex flex-col gap-3 p-4 md:p-6" data-testid="portal-statement">
      <h2 className="text-lg font-semibold">
        {t('portal.page.statement')}: {page.party.name}
      </h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-fg-muted">
            <th className="py-1 pr-2">{t('portal.page.date')}</th>
            <th className="py-1 pr-2">{t('portal.page.ref')}</th>
            <th className="py-1 pr-2">{t('portal.page.description')}</th>
            <th className="py-1 pr-2 text-right">{t('portal.page.debit')}</th>
            <th className="py-1 pr-2 text-right">{t('portal.page.credit')}</th>
            <th className="py-1 text-right">{t('portal.page.runningBalance')}</th>
          </tr>
        </thead>
        <tbody>
          {page.openingPaise !== 0 && (
            <tr className="border-t border-border">
              <td colSpan={5} className="py-1">
                {t('portal.page.opening')}
              </td>
              <td className="py-1 text-right">{money(page.openingPaise)}</td>
            </tr>
          )}
          {page.lines.map((l, i) => (
            <tr key={i} className="border-t border-border" data-testid="portal-statement-line">
              <td className="py-1 pr-2">{date(l.date)}</td>
              <td className="py-1 pr-2">{l.ref}</td>
              <td className="py-1 pr-2 capitalize">{l.description}</td>
              <td className="py-1 pr-2 text-right">{l.debitPaise ? money(l.debitPaise) : ''}</td>
              <td className="py-1 pr-2 text-right">{l.creditPaise ? money(l.creditPaise) : ''}</td>
              <td className="py-1 text-right">{money(l.balancePaise)}</td>
            </tr>
          ))}
          <tr className="border-t border-border font-semibold">
            <td colSpan={5} className="py-1">
              {t('portal.page.closing')}
            </td>
            <td className="py-1 text-right" data-testid="portal-closing">
              {money(page.closingPaise)}
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

function QuestionForm({ client, token }: { client: CloudClient; token: string }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await client.portalQuestion(token, {
        name: name.trim() || null,
        contact: contact.trim() || null,
        text: text.trim(),
      });
      setSent(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="portal-question">
      <h2 className="font-medium">{t('portal.page.ask')}</h2>
      <p className="text-xs text-fg-muted">{t('portal.page.askHelp')}</p>
      {sent ? (
        <p className="text-sm" data-testid="portal-question-sent">
          {t('portal.page.sent')}
        </p>
      ) : (
        <>
          <div className="grid gap-2 md:grid-cols-2">
            <Input
              placeholder={t('portal.page.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="portal-question-name"
            />
            <Input
              placeholder={t('portal.page.contact')}
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              data-testid="portal-question-contact"
            />
          </div>
          <Textarea
            placeholder={t('portal.page.message')}
            value={text}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            data-testid="portal-question-text"
          />
          <div>
            <Button
              onClick={() => void send()}
              disabled={busy || !text.trim()}
              data-testid="portal-question-send"
            >
              {t('portal.page.send')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

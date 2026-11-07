/**
 * The ledger (prompt 50): the chart of accounts, journal vouchers, recurring journals, the trial balance with
 * drill-down to a ledger statement, profit and loss, the balance sheet, a simple cash flow, the day book, and
 * the year end (opening balances, close and reopen, and the audit that repairs missing postings). Every figure
 * comes from `LedgerReports` over the entries the documents and payments have been posting since Phase 1.
 */
import {
  ChartRepo,
  FiscalYearRepo,
  JournalRepo,
  LedgerAudit,
  LedgerReports,
  RecurringJournalRepo,
  type AccountStatement,
  type ChartAccount,
  type FiscalYearView,
  type LedgerVerification,
  type RecurringJournal,
  type Voucher,
  type VoucherKind,
  type VoucherLineInput,
} from '@gst/db';
import {
  SUB_GROUPS,
  fyOf,
  toCsv,
  today,
  type AccountType,
  type BalanceSheet,
  type CashFlow,
  type CsvValue,
  type ProfitAndLoss,
  type StatementGroup,
  type TrialBalance,
} from '@gst/domain';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  MoneyText,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
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
  formatPaise,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirm } from '@/app/components/confirm';
import { useAppDb, useLiveQuery } from '@/app/db';
import { useAppNavigate, useLocationInfo } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { editorPath } from '@/features/documents/editor-page';
import { CSV_MIME, downloadBytes, fileSafe } from '@/features/reports/download';
import { dyn } from '@/lib/dyn-key';

const TABLES = [
  'ledger_entries',
  'ledger_accounts',
  'journal_vouchers',
  'fiscal_years',
  'recurring_journals',
  'settings',
  'documents',
  'payments',
];
const TABS = [
  'chart',
  'journal',
  'recurring',
  'tb',
  'statement',
  'pl',
  'bs',
  'cashflow',
  'daybook',
  'yearend',
] as const;
type Tab = (typeof TABS)[number];
const TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const rupees = (p: bigint): CsvValue => ({ numeric: (Number(p) / 100).toFixed(2) });
const parsePaise = (s: string): bigint => BigInt(Math.round((Number(s) || 0) * 100));
const todayIso = () => today(() => new Date());

export function LedgerPage({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const { business } = useAppDb();
  const { search } = useLocationInfo();
  const wanted =
    typeof search['tab'] === 'string' && (TABS as readonly string[]).includes(search['tab'])
      ? (search['tab'] as Tab)
      : 'tb';
  const [tab, setTab] = useState<Tab>(wanted);
  const fy = fyOf(todayIso(), Number(business?.['fy_start_month'] ?? 4));
  const [from, setFrom] = useState(fy.start);
  const [to, setTo] = useState(fy.end);
  const [account, setAccount] = useState<string | null>(
    typeof search['account'] === 'string' ? search['account'] : null,
  );
  if (!business) return null;
  const open = (id: string) => {
    setAccount(id);
    setTab('statement');
  };
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="ledger-page">
      <PageHeader
        title={t('ledger.title')}
        description={t('ledger.subtitle')}
        actions={
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col">
              {t('ledger.from')}
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                data-testid="ledger-from"
              />
            </label>
            <label className="flex flex-col">
              {t('ledger.to')}
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                data-testid="ledger-to"
              />
            </label>
          </div>
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList aria-label={t('ledger.title')}>
          {TABS.map((k) => (
            <TabsTrigger key={k} value={k} data-testid={`ledger-tab-${k}`}>
              {t(dyn(`ledger.tabs.${k}`))}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="chart">
          <ChartTab onOpen={open} />
        </TabsContent>
        <TabsContent value="journal">
          <JournalTab from={from} to={to} shell={shell} />
        </TabsContent>
        <TabsContent value="recurring">
          <RecurringTab />
        </TabsContent>
        <TabsContent value="tb">
          <TrialBalanceTab from={from} to={to} onOpen={open} />
        </TabsContent>
        <TabsContent value="statement">
          <StatementTab
            from={from}
            to={to}
            account={account}
            setAccount={setAccount}
            shell={shell}
          />
        </TabsContent>
        <TabsContent value="pl">
          <ProfitAndLossTab from={from} to={to} />
        </TabsContent>
        <TabsContent value="bs">
          <BalanceSheetTab asAt={to} />
        </TabsContent>
        <TabsContent value="cashflow">
          <CashFlowTab from={from} to={to} />
        </TabsContent>
        <TabsContent value="daybook">
          <DayBookTab from={from} to={to} shell={shell} />
        </TabsContent>
        <TabsContent value="yearend">
          <YearEndTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* --------------------------------------------------------------------------------- shared */

function useAccounts() {
  return useLiveQuery<ChartAccount[]>({
    tables: ['ledger_accounts'],
    key: ['chart'],
    fn: (d, c) => new ChartRepo(d).accounts(c),
  });
}

function AccountSelect({
  value,
  onChange,
  accounts,
  testId,
}: {
  value: string | null;
  onChange: (id: string) => void;
  accounts: ChartAccount[];
  testId?: string;
}) {
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger className="w-72" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {accounts.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.code} · {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function exportCsv(name: string, rows: CsvValue[][]) {
  downloadBytes(`${fileSafe(name)}.csv`, toCsv(rows), CSV_MIME);
}

function ExportPrint({
  name,
  rows,
  testId,
}: {
  name: string;
  rows: () => CsvValue[][];
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-2">
      <Button
        variant="outline"
        onClick={() => exportCsv(name, rows())}
        data-testid={`${testId}-csv`}
      >
        {t('ledger.exportCsv')}
      </Button>
      <Button variant="outline" onClick={() => window.print()}>
        {t('ledger.print')}
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------------------------- chart */

function ChartTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const accounts = useAccounts();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ChartAccount | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('expense');
  const [subGroup, setSubGroup] = useState<string>('indirect_expenses');
  const [tally, setTally] = useState('');
  const confirm = useConfirm();
  if (!accounts.data || !database || !ctx) return null;
  const repo = new ChartRepo(database);
  const save = async () => {
    try {
      if (editing)
        await repo.updateAccount(
          ctx,
          editing.id,
          { name, subGroup, tallyName: tally || null },
          editing.version,
        );
      else await repo.createAccount(ctx, { name, type, subGroup, tallyName: tally || null });
      toast.success(t('ledger.chart.saved'));
      setAdding(false);
      setEditing(null);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const startEdit = (a: ChartAccount) => {
    setEditing(a);
    setName(a.name);
    setType(a.type);
    setSubGroup(a.subGroup ?? SUB_GROUPS[a.type][0]!);
    setTally(a.tallyName ?? '');
  };
  const remove = async (a: ChartAccount) => {
    if (!(await confirm({ title: t('ledger.chart.removeConfirm', { name: a.name }) }))) return;
    try {
      await repo.archiveAccount(ctx, a.id, a.version);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="ledger-chart">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-fg-muted">{t('ledger.chart.help')}</p>
        <Button
          onClick={() => {
            setEditing(null);
            setName('');
            setType('expense');
            setSubGroup('indirect_expenses');
            setTally('');
            setAdding(true);
          }}
          data-testid="chart-add"
        >
          {t('ledger.chart.add')}
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            void repo
              .ensureSystem(ctx)
              .then((n) => toast.success(t('ledger.chart.ensured', { count: n })))
          }
        >
          {t('ledger.chart.ensure')}
        </Button>
      </div>
      {TYPES.map((ty) => (
        <Card key={ty} className="p-3">
          <h2 className="pb-2 font-medium">{t(dyn(`ledger.types.${ty}`))}</h2>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('ledger.chart.code')}</TableHeaderCell>
                <TableHeaderCell>{t('ledger.chart.name')}</TableHeaderCell>
                <TableHeaderCell>{t('ledger.chart.group')}</TableHeaderCell>
                <TableHeaderCell>{t('ledger.chart.tally')}</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {accounts.data
                .filter((a) => a.type === ty)
                .map((a) => (
                  <TableRow key={a.id} data-testid="chart-row" data-code={a.code}>
                    <TableCell className="tabular">{a.code}</TableCell>
                    <TableCell>
                      <button type="button" className="underline" onClick={() => onOpen(a.id)}>
                        {a.name}
                      </button>
                      {a.isSystem && <Badge tone="neutral">{t('ledger.chart.system')}</Badge>}
                    </TableCell>
                    <TableCell>{a.subGroup ? t(dyn(`ledger.groups.${a.subGroup}`)) : ''}</TableCell>
                    <TableCell>{a.tallyName ?? ''}</TableCell>
                    <TableCell>
                      <Button variant="ghost" onClick={() => startEdit(a)}>
                        {t('ledger.chart.edit')}
                      </Button>
                      {!a.isSystem && (
                        <Button variant="ghost" onClick={() => void remove(a)}>
                          {t('ledger.chart.remove')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </Card>
      ))}
      {(adding || editing) && (
        <Dialog open onOpenChange={(o) => !o && (setAdding(false), setEditing(null))}>
          <DialogContent data-testid="chart-dialog">
            <DialogTitle>
              {editing ? t('ledger.chart.editTitle') : t('ledger.chart.add')}
            </DialogTitle>
            <div className="flex flex-col gap-2 text-sm">
              <label className="flex flex-col">
                {t('ledger.chart.name')}
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="chart-name"
                />
              </label>
              {!editing && (
                <label className="flex flex-col">
                  {t('ledger.chart.type')}
                  <Select
                    value={type}
                    onValueChange={(v) => {
                      setType(v as AccountType);
                      setSubGroup(SUB_GROUPS[v as AccountType][0]!);
                    }}
                  >
                    <SelectTrigger data-testid="chart-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPES.map((ty) => (
                        <SelectItem key={ty} value={ty}>
                          {t(dyn(`ledger.types.${ty}`))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              )}
              <label className="flex flex-col">
                {t('ledger.chart.group')}
                <Select value={subGroup} onValueChange={setSubGroup}>
                  <SelectTrigger data-testid="chart-group">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUB_GROUPS[type].map((g) => (
                      <SelectItem key={g} value={g}>
                        {t(dyn(`ledger.groups.${g}`))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col">
                {t('ledger.chart.tally')}
                <Input
                  value={tally}
                  onChange={(e) => setTally(e.target.value)}
                  data-testid="chart-tally"
                />
              </label>
              <div className="flex justify-end">
                <Button
                  onClick={() => void save()}
                  disabled={!name.trim()}
                  data-testid="chart-save"
                >
                  {t('ledger.chart.save')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------------- journal */

interface LineDraft {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
}
const blankLine = (key: number): LineDraft => ({ key, accountId: '', debit: '', credit: '' });

function VoucherDialog({
  accounts,
  onClose,
  kind: initialKind,
}: {
  accounts: ChartAccount[];
  onClose: (posted: Voucher | null) => void;
  kind: VoucherKind;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [date, setDate] = useState(todayIso());
  const [kind, setKind] = useState<VoucherKind>(initialKind);
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([blankLine(1), blankLine(2)]);
  const [busy, setBusy] = useState(false);
  const dr = lines.reduce((a, l) => a + parsePaise(l.debit), 0n);
  const cr = lines.reduce((a, l) => a + parsePaise(l.credit), 0n);
  const balanced = dr === cr && dr > 0n;
  const set = (key: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const post = async () => {
    if (!database || !ctx) return;
    setBusy(true);
    try {
      const v = await new JournalRepo(database).post(ctx, {
        date,
        kind,
        narration,
        lines: lines
          .filter((l) => l.accountId)
          .map<VoucherLineInput>((l) => ({
            accountId: l.accountId,
            debitPaise: parsePaise(l.debit),
            creditPaise: parsePaise(l.credit),
          })),
      });
      toast.success(t('ledger.journal.posted', { number: v.number }));
      onClose(v);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose(null)}>
      <DialogContent className="max-w-3xl" data-testid="voucher-dialog">
        <DialogTitle>{t('ledger.journal.new')}</DialogTitle>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col">
            {t('ledger.journal.date')}
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              data-testid="voucher-date"
            />
          </label>
          <label className="flex flex-col">
            {t('ledger.journal.kind')}
            <Select value={kind} onValueChange={(v) => setKind(v as VoucherKind)}>
              <SelectTrigger className="w-40" data-testid="voucher-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['journal', 'contra'] as const).map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(dyn(`ledger.kinds.${k}`))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex flex-1 flex-col">
            {t('ledger.journal.narration')}
            <Input
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              data-testid="voucher-narration"
            />
          </label>
        </div>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('ledger.journal.account')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('ledger.debit')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('ledger.credit')}</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {lines.map((l, i) => (
              <TableRow key={l.key} data-testid="voucher-line">
                <TableCell>
                  <AccountSelect
                    value={l.accountId || null}
                    onChange={(id) => set(l.key, { accountId: id })}
                    accounts={accounts}
                    testId={`voucher-account-${i}`}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={l.debit}
                    onChange={(e) =>
                      set(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })
                    }
                    className="w-32 text-right"
                    data-testid={`voucher-debit-${i}`}
                    aria-label={t('ledger.debit')}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={l.credit}
                    onChange={(e) =>
                      set(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })
                    }
                    className="w-32 text-right"
                    data-testid={`voucher-credit-${i}`}
                    aria-label={t('ledger.credit')}
                  />
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    aria-label={t('ledger.journal.removeLine')}
                  >
                    ×
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            <TableRow className="font-semibold" data-testid="voucher-totals">
              <TableCell>{t('ledger.total')}</TableCell>
              <TableCell className="text-right">{formatPaise(dr)}</TableCell>
              <TableCell className="text-right">{formatPaise(cr)}</TableCell>
              <TableCell>
                <Badge tone={balanced ? 'success' : 'warning'} data-testid="voucher-balance">
                  {balanced
                    ? t('ledger.journal.balanced')
                    : t('ledger.journal.difference', {
                        amount: formatPaise(dr > cr ? dr - cr : cr - dr),
                      })}
                </Badge>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={() => setLines((ls) => [...ls, blankLine((ls.at(-1)?.key ?? 0) + 1)])}
            data-testid="voucher-add-line"
          >
            {t('ledger.journal.addLine')}
          </Button>
          <Button
            onClick={() => void post()}
            disabled={!balanced || busy}
            data-testid="voucher-post"
          >
            {t('ledger.journal.post')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function JournalTab({ from, to, shell }: { from: string; to: string; shell: Shell }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const accounts = useAccounts();
  const [open, setOpen] = useState<VoucherKind | null>(null);
  const confirm = useConfirm();
  const vouchers = useLiveQuery<Voucher[]>({
    tables: ['journal_vouchers', 'ledger_entries'],
    key: ['vouchers', from, to],
    fn: (d, c) => new JournalRepo(d).vouchers(c, { from, to }),
  });
  void shell;
  const reverse = async (v: Voucher) => {
    const reason = window.prompt(t('ledger.journal.reverseReason'));
    if (!reason || !database || !ctx) return;
    if (!(await confirm({ title: t('ledger.journal.reverseConfirm', { number: v.number }) })))
      return;
    try {
      await new JournalRepo(database).reverse(ctx, v.id, reason);
      toast.success(t('ledger.journal.reversed'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="ledger-journal">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setOpen('journal')} data-testid="journal-new">
          {t('ledger.journal.new')}
        </Button>
        <Button variant="outline" onClick={() => setOpen('contra')} data-testid="journal-contra">
          {t('ledger.journal.newContra')}
        </Button>
      </div>
      {open && accounts.data && (
        <VoucherDialog accounts={accounts.data} kind={open} onClose={() => setOpen(null)} />
      )}
      {vouchers.data && vouchers.data.length === 0 && (
        <p className="text-sm text-fg-muted">{t('ledger.journal.none')}</p>
      )}
      {(vouchers.data ?? []).map((v) => (
        <Card
          key={v.id}
          className="p-3"
          data-testid="voucher-row"
          data-kind={v.kind}
          data-status={v.status}
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{v.number}</span>
            <span>{v.date}</span>
            <Badge tone="neutral">{t(dyn(`ledger.kinds.${v.kind}`))}</Badge>
            {v.status === 'reversed' && (
              <Badge tone="warning">{t('ledger.journal.reversedBadge')}</Badge>
            )}
            <span className="text-fg-muted">{v.narration}</span>
            <span className="ml-auto">
              <MoneyText paise={v.totalPaise} />
            </span>
            {v.status === 'posted' && v.kind !== 'closing' && (
              <Button variant="ghost" onClick={() => void reverse(v)} data-testid="voucher-reverse">
                {t('ledger.journal.reverse')}
              </Button>
            )}
          </div>
          <ul className="pt-1 text-xs text-fg-muted">
            {v.lines.map((l) => (
              <li key={l.id}>
                {l.code} {l.name}:{' '}
                {l.debitPaise > 0n
                  ? `${t('ledger.dr')} ${formatPaise(l.debitPaise)}`
                  : `${t('ledger.cr')} ${formatPaise(l.creditPaise)}`}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------------- recurring */

function RecurringTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const accounts = useAccounts();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [every, setEvery] = useState<RecurringJournal['every']>('monthly');
  const [day, setDay] = useState('1');
  const [start, setStart] = useState(todayIso());
  const [lines, setLines] = useState<LineDraft[]>([blankLine(1), blankLine(2)]);
  const list = useLiveQuery<RecurringJournal[]>({
    tables: ['recurring_journals'],
    key: ['recurring'],
    fn: (d, c) => new RecurringJournalRepo(d).all(c),
  });
  if (!database || !ctx) return null;
  const repo = new RecurringJournalRepo(database);
  const set = (key: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const save = async () => {
    try {
      await repo.createRecurring(ctx, {
        name,
        every,
        day: Number(day) || 1,
        startDate: start,
        lines: lines
          .filter((l) => l.accountId)
          .map((l) => ({
            accountId: l.accountId,
            debitPaise: parsePaise(l.debit),
            creditPaise: parsePaise(l.credit),
          })),
      });
      toast.success(t('ledger.recurring.saved'));
      setAdding(false);
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const postDue = async () => {
    try {
      const r = await repo.postDue(ctx, todayIso());
      toast.success(t('ledger.recurring.postedDue', { count: r.posted }));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="ledger-recurring">
      <p className="text-sm text-fg-muted">{t('ledger.recurring.help')}</p>
      <div className="flex gap-2">
        <Button onClick={() => setAdding(true)} data-testid="recurring-add">
          {t('ledger.recurring.add')}
        </Button>
        <Button variant="outline" onClick={() => void postDue()} data-testid="recurring-post-due">
          {t('ledger.recurring.postDue')}
        </Button>
      </div>
      <ul className="flex flex-col gap-2 text-sm">
        {(list.data ?? []).map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-2 rounded border border-border p-2"
            data-testid="recurring-row"
          >
            <span className="font-medium">{r.name}</span>
            <span>{t(dyn(`ledger.recurring.every.${r.every}`))}</span>
            <span className="text-fg-muted">
              {t('ledger.recurring.next', { date: r.nextDate })}
            </span>
            <Switch
              checked={r.active}
              onCheckedChange={(v) =>
                void repo.updateRecurring(ctx, r.id, { active: v }, r.version)
              }
              aria-label={t('ledger.recurring.active')}
            />
          </li>
        ))}
      </ul>
      {adding && accounts.data && (
        <Dialog open onOpenChange={(o) => !o && setAdding(false)}>
          <DialogContent className="max-w-3xl" data-testid="recurring-dialog">
            <DialogTitle>{t('ledger.recurring.add')}</DialogTitle>
            <div className="flex flex-wrap items-end gap-2 text-sm">
              <label className="flex flex-col">
                {t('ledger.recurring.name')}
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="recurring-name"
                />
              </label>
              <label className="flex flex-col">
                {t('ledger.recurring.everyLabel')}
                <Select
                  value={every}
                  onValueChange={(v) => setEvery(v as RecurringJournal['every'])}
                >
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['monthly', 'quarterly', 'yearly'] as const).map((k) => (
                      <SelectItem key={k} value={k}>
                        {t(dyn(`ledger.recurring.every.${k}`))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col">
                {t('ledger.recurring.day')}
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                  className="w-20"
                />
              </label>
              <label className="flex flex-col">
                {t('ledger.recurring.start')}
                <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
              </label>
            </div>
            {lines.map((l, i) => (
              <div key={l.key} className="flex items-center gap-2">
                <AccountSelect
                  value={l.accountId || null}
                  onChange={(id) => set(l.key, { accountId: id })}
                  accounts={accounts.data!}
                  testId={`recurring-account-${i}`}
                />
                <Input
                  type="number"
                  placeholder={t('ledger.debit')}
                  value={l.debit}
                  onChange={(e) => set(l.key, { debit: e.target.value })}
                  className="w-28"
                  data-testid={`recurring-debit-${i}`}
                />
                <Input
                  type="number"
                  placeholder={t('ledger.credit')}
                  value={l.credit}
                  onChange={(e) => set(l.key, { credit: e.target.value })}
                  className="w-28"
                  data-testid={`recurring-credit-${i}`}
                />
              </div>
            ))}
            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => setLines((ls) => [...ls, blankLine((ls.at(-1)?.key ?? 0) + 1)])}
              >
                {t('ledger.journal.addLine')}
              </Button>
              <Button
                onClick={() => void save()}
                disabled={!name.trim()}
                data-testid="recurring-save"
              >
                {t('ledger.chart.save')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------- trial balance */

function TrialBalanceTab({
  from,
  to,
  onOpen,
}: {
  from: string;
  to: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const tb = useLiveQuery<TrialBalance>({
    tables: TABLES,
    key: ['tb', from, to],
    fn: (d, c) => new LedgerReports(d).trialBalance(c, { from, to }),
  });
  if (tb.error) return <p className="text-danger">{errText(tb.error)}</p>;
  if (!tb.data) return <p className="text-fg-muted">{t('empty.loading')}</p>;
  const { rows, totals } = tb.data;
  const csv = () => [
    [
      t('ledger.chart.code'),
      t('ledger.chart.name'),
      t('ledger.tb.openingDr'),
      t('ledger.tb.openingCr'),
      t('ledger.debit'),
      t('ledger.credit'),
      t('ledger.tb.closingDr'),
      t('ledger.tb.closingCr'),
    ],
    ...rows.map((r) => [
      r.account.code,
      r.account.name,
      rupees(r.openingDrPaise),
      rupees(r.openingCrPaise),
      rupees(r.debitPaise),
      rupees(r.creditPaise),
      rupees(r.closingDrPaise),
      rupees(r.closingCrPaise),
    ]),
    [
      '',
      t('ledger.total'),
      rupees(totals.openingDrPaise),
      rupees(totals.openingCrPaise),
      rupees(totals.debitPaise),
      rupees(totals.creditPaise),
      rupees(totals.closingDrPaise),
      rupees(totals.closingCrPaise),
    ],
  ];
  return (
    <div className="flex flex-col gap-2" data-testid="ledger-tb">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{t('ledger.tb.help')}</p>
        <ExportPrint name={`Trial_balance_${from}_${to}`} rows={csv} testId="tb-export" />
      </div>
      <div className="print-area">
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('ledger.chart.code')}</TableHeaderCell>
              <TableHeaderCell>{t('ledger.chart.name')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('ledger.tb.openingDr')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('ledger.tb.openingCr')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('ledger.debit')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('ledger.credit')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('ledger.tb.closingDr')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('ledger.tb.closingCr')}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.account.id} data-testid="tb-row" data-code={r.account.code}>
                <TableCell className="tabular">{r.account.code}</TableCell>
                <TableCell>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => onOpen(r.account.id)}
                    data-testid="tb-drill"
                  >
                    {r.account.name}
                  </button>
                </TableCell>
                {[
                  r.openingDrPaise,
                  r.openingCrPaise,
                  r.debitPaise,
                  r.creditPaise,
                  r.closingDrPaise,
                  r.closingCrPaise,
                ].map((p, i) => (
                  <TableCell key={i} className="text-right tabular">
                    {p === 0n ? '' : formatPaise(p)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            <TableRow className="font-semibold" data-testid="tb-totals">
              <TableCell colSpan={2}>{t('ledger.total')}</TableCell>
              {[
                totals.openingDrPaise,
                totals.openingCrPaise,
                totals.debitPaise,
                totals.creditPaise,
                totals.closingDrPaise,
                totals.closingCrPaise,
              ].map((p, i) => (
                <TableCell key={i} className="text-right tabular">
                  {formatPaise(p)}
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------- statement */

function StatementTab({
  from,
  to,
  account,
  setAccount,
  shell,
}: {
  from: string;
  to: string;
  account: string | null;
  setAccount: (id: string) => void;
  shell: Shell;
}) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const accounts = useAccounts();
  const st = useLiveQuery<AccountStatement | null>({
    tables: TABLES,
    key: ['statement', account, from, to],
    enabled: !!account,
    fn: (d, c) =>
      account ? new LedgerReports(d).statement(c, account, { from, to }) : Promise.resolve(null),
  });
  const rows = st.data?.rows ?? [];
  const csv = () =>
    st.data
      ? [
          [
            t('ledger.journal.date'),
            t('ledger.statement.ref'),
            t('ledger.journal.narration'),
            t('ledger.debit'),
            t('ledger.credit'),
            t('ledger.statement.balance'),
          ],
          ...rows.map((r) => [
            r.date,
            refOf(r.source),
            r.narration ?? '',
            rupees(r.debitPaise),
            rupees(r.creditPaise),
            rupees(r.balancePaise),
          ]),
        ]
      : [];
  const openSource = (s: AccountStatement['rows'][number]['source']) => {
    if (s.kind === 'document') navigate(editorPath(shell), { id: s.id });
  };
  return (
    <div className="flex flex-col gap-2" data-testid="ledger-statement">
      <div className="flex flex-wrap items-center gap-2">
        {accounts.data && (
          <AccountSelect
            value={account}
            onChange={setAccount}
            accounts={accounts.data}
            testId="statement-account"
          />
        )}
        {st.data && (
          <ExportPrint
            name={`Ledger_${st.data.account.code}_${from}_${to}`}
            rows={csv}
            testId="statement-export"
          />
        )}
      </div>
      {!account && <p className="text-sm text-fg-muted">{t('ledger.statement.pick')}</p>}
      {st.data && (
        <div className="print-area">
          <p className="font-medium" data-testid="statement-title">
            {st.data.account.code} · {st.data.account.name}
          </p>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>{t('ledger.journal.date')}</TableHeaderCell>
                <TableHeaderCell>{t('ledger.statement.ref')}</TableHeaderCell>
                <TableHeaderCell>{t('ledger.journal.narration')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('ledger.debit')}</TableHeaderCell>
                <TableHeaderCell className="text-right">{t('ledger.credit')}</TableHeaderCell>
                <TableHeaderCell className="text-right">
                  {t('ledger.statement.balance')}
                </TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              <TableRow data-testid="statement-opening">
                <TableCell colSpan={5}>{t('ledger.statement.opening')}</TableCell>
                <TableCell className="text-right tabular">
                  {formatPaise(st.data.openingPaise)}
                </TableCell>
              </TableRow>
              {rows.map((r) => (
                <TableRow key={r.id} data-testid="statement-row">
                  <TableCell className="tabular">{r.date}</TableCell>
                  <TableCell>
                    {r.source.kind === 'document' ? (
                      <button
                        type="button"
                        className="underline"
                        onClick={() => openSource(r.source)}
                      >
                        {refOf(r.source)}
                      </button>
                    ) : (
                      refOf(r.source)
                    )}
                  </TableCell>
                  <TableCell>{r.narration}</TableCell>
                  <TableCell className="text-right tabular">
                    {r.debitPaise ? formatPaise(r.debitPaise) : ''}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {r.creditPaise ? formatPaise(r.creditPaise) : ''}
                  </TableCell>
                  <TableCell className="text-right tabular">
                    {formatPaise(r.balancePaise)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold" data-testid="statement-closing">
                <TableCell colSpan={3}>{t('ledger.statement.closing')}</TableCell>
                <TableCell className="text-right tabular">
                  {formatPaise(st.data.debitPaise)}
                </TableCell>
                <TableCell className="text-right tabular">
                  {formatPaise(st.data.creditPaise)}
                </TableCell>
                <TableCell className="text-right tabular">
                  {formatPaise(st.data.closingPaise)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

const refOf = (s: AccountStatement['rows'][number]['source']): string =>
  s.kind === 'document'
    ? `${s.type} ${s.number ?? ''}${s.partyName ? ` · ${s.partyName}` : ''}`
    : s.kind === 'payment'
      ? `${s.direction} ${s.mode}${s.reference ? ` ${s.reference}` : ''}`
      : s.kind === 'voucher'
        ? s.number
        : '';

/* ------------------------------------------------------------------------- P&L and balance sheet */

function Groups({
  groups,
  label,
  testId,
}: {
  groups: StatementGroup[];
  label: string;
  testId: string;
}) {
  const { t } = useTranslation();
  const compare = groups.some((g) => g.comparePaise !== null);
  return (
    <Table data-testid={testId}>
      <TableHead>
        <TableRow>
          <TableHeaderCell>{label}</TableHeaderCell>
          <TableHeaderCell className="text-right">{t('ledger.amount')}</TableHeaderCell>
          {compare && (
            <TableHeaderCell className="text-right">{t('ledger.compare')}</TableHeaderCell>
          )}
        </TableRow>
      </TableHead>
      <TableBody>
        {groups.map((g) => (
          <>
            <TableRow key={g.subGroup} className="font-medium">
              <TableCell>{t(dyn(`ledger.groups.${g.subGroup}`))}</TableCell>
              <TableCell className="text-right tabular">{formatPaise(g.paise)}</TableCell>
              {compare && (
                <TableCell className="text-right tabular">
                  {formatPaise(g.comparePaise ?? 0n)}
                </TableCell>
              )}
            </TableRow>
            {g.lines.map((l) => (
              <TableRow
                key={l.account.id}
                data-testid={`${testId}-line`}
                data-code={l.account.code}
              >
                <TableCell className="pl-6 text-fg-muted">
                  {l.account.code} {l.account.name}
                </TableCell>
                <TableCell className="text-right tabular">{formatPaise(l.paise)}</TableCell>
                {compare && (
                  <TableCell className="text-right tabular">
                    {formatPaise(l.comparePaise ?? 0n)}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </>
        ))}
      </TableBody>
    </Table>
  );
}

const groupRows = (t: (k: string) => string, groups: StatementGroup[]): CsvValue[][] =>
  groups.flatMap((g) => [
    [
      t(`ledger.groups.${g.subGroup}`),
      rupees(g.paise),
      g.comparePaise === null ? '' : rupees(g.comparePaise),
    ],
    ...g.lines.map((l) => [
      `  ${l.account.code} ${l.account.name}`,
      rupees(l.paise),
      l.comparePaise === null ? '' : rupees(l.comparePaise),
    ]),
  ]);

function ProfitAndLossTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const { business } = useAppDb();
  const [compare, setCompare] = useState(false);
  const prev = (() => {
    const fy = fyOf(from, Number(business?.['fy_start_month'] ?? 4));
    const years = fy.startYear - 1;
    const shift = (d: string) => `${Number(d.slice(0, 4)) - (fy.startYear - years)}${d.slice(4)}`;
    return { from: shift(from), to: shift(to) };
  })();
  const pl = useLiveQuery<ProfitAndLoss>({
    tables: TABLES,
    key: ['pl', from, to, compare],
    fn: (d, c) => new LedgerReports(d).profitAndLoss(c, { from, to }, compare ? prev : undefined),
  });
  if (!pl.data) return <p className="text-fg-muted">{t('empty.loading')}</p>;
  const p = pl.data;
  const tr = (k: string) => t(dyn(k));
  const csv = () => [
    [t('ledger.pl.income'), t('ledger.amount'), compare ? t('ledger.compare') : ''],
    ...groupRows(tr, p.income),
    [t('ledger.pl.expenses')],
    ...groupRows(tr, p.expenses),
    [t('ledger.pl.net'), rupees(p.netPaise), p.compare ? rupees(p.compare.netPaise) : ''],
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="ledger-pl">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={compare} onCheckedChange={setCompare} data-testid="pl-compare" />
          {t('ledger.compareLastYear', { from: prev.from, to: prev.to })}
        </label>
        <ExportPrint name={`Profit_and_loss_${from}_${to}`} rows={csv} testId="pl-export" />
      </div>
      <div className="print-area grid gap-3 md:grid-cols-2">
        <Card className="p-3">
          <Groups groups={p.income} label={t('ledger.pl.income')} testId="pl-income" />
          <p className="pt-2 text-right font-semibold" data-testid="pl-income-total">
            {formatPaise(p.incomePaise)}
          </p>
        </Card>
        <Card className="p-3">
          <Groups groups={p.expenses} label={t('ledger.pl.expenses')} testId="pl-expenses" />
          <p className="pt-2 text-right font-semibold">{formatPaise(p.expensesPaise)}</p>
        </Card>
      </div>
      <p className="text-right text-lg font-semibold" data-testid="pl-net">
        {p.netPaise >= 0n ? t('ledger.pl.profit') : t('ledger.pl.loss')}:{' '}
        {formatPaise(p.netPaise < 0n ? -p.netPaise : p.netPaise)}
        {p.compare && (
          <span className="pl-3 text-sm text-fg-muted">
            {t('ledger.compare')}: {formatPaise(p.compare.netPaise)}
          </span>
        )}
      </p>
      <p className="text-xs text-fg-muted">{t('ledger.pl.note')}</p>
    </div>
  );
}

function BalanceSheetTab({ asAt }: { asAt: string }) {
  const { t } = useTranslation();
  const [compare, setCompare] = useState(false);
  const prevAsAt = `${Number(asAt.slice(0, 4)) - 1}${asAt.slice(4)}`;
  const bs = useLiveQuery<BalanceSheet>({
    tables: TABLES,
    key: ['bs', asAt, compare],
    fn: (d, c) => new LedgerReports(d).balanceSheet(c, asAt, compare ? prevAsAt : undefined),
  });
  if (!bs.data) return <p className="text-fg-muted">{t('empty.loading')}</p>;
  const b = bs.data;
  const tr = (k: string) => t(dyn(k));
  const csv = () => [
    [t('ledger.bs.assets'), t('ledger.amount'), compare ? t('ledger.compare') : ''],
    ...groupRows(tr, b.assets),
    [t('ledger.bs.liabilities')],
    ...groupRows(tr, b.liabilities),
    [t('ledger.bs.equity')],
    ...groupRows(tr, b.equity),
    [
      t('ledger.bs.unclosed'),
      rupees(b.unclosedProfitPaise),
      b.compare ? rupees(b.compare.unclosedProfitPaise) : '',
    ],
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="ledger-bs">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-fg-muted">{t('ledger.bs.asAt', { date: asAt })}</p>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={compare} onCheckedChange={setCompare} data-testid="bs-compare" />
          {t('ledger.bs.compare', { date: prevAsAt })}
        </label>
        <ExportPrint name={`Balance_sheet_${asAt}`} rows={csv} testId="bs-export" />
      </div>
      <div className="print-area grid gap-3 md:grid-cols-2">
        <Card className="p-3">
          <Groups groups={b.assets} label={t('ledger.bs.assets')} testId="bs-assets" />
          <p className="pt-2 text-right font-semibold" data-testid="bs-assets-total">
            {formatPaise(b.assetsPaise)}
          </p>
        </Card>
        <Card className="p-3">
          <Groups
            groups={b.liabilities}
            label={t('ledger.bs.liabilities')}
            testId="bs-liabilities"
          />
          <p className="pt-2 text-right font-semibold">{formatPaise(b.liabilitiesPaise)}</p>
          <Groups groups={b.equity} label={t('ledger.bs.equity')} testId="bs-equity" />
          <p className="pt-2 text-right">
            {t('ledger.bs.unclosed')}: {formatPaise(b.unclosedProfitPaise)}
          </p>
          <p className="pt-2 text-right font-semibold" data-testid="bs-liabilities-total">
            {formatPaise(b.liabilitiesPaise + b.equityPaise + b.unclosedProfitPaise)}
          </p>
        </Card>
      </div>
      <p
        className="text-xs"
        data-testid="bs-difference"
        data-ties={b.differencePaise === 0n ? 'yes' : 'no'}
      >
        {b.differencePaise === 0n
          ? t('ledger.bs.ties')
          : t('ledger.bs.difference', { amount: formatPaise(b.differencePaise) })}
      </p>
    </div>
  );
}

function CashFlowTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const cf = useLiveQuery<CashFlow>({
    tables: TABLES,
    key: ['cashflow', from, to],
    fn: (d, c) => new LedgerReports(d).cashFlow(c, { from, to }),
  });
  if (!cf.data) return <p className="text-fg-muted">{t('empty.loading')}</p>;
  const c = cf.data;
  const section = (label: string, lines: CashFlow['operating'], total: bigint) => (
    <>
      <TableRow className="font-medium">
        <TableCell>{label}</TableCell>
        <TableCell className="text-right tabular">{formatPaise(total)}</TableCell>
      </TableRow>
      {lines.map((l, i) => (
        <TableRow key={`${label}${i}`}>
          <TableCell className="pl-6 text-fg-muted">{l.label}</TableCell>
          <TableCell className="text-right tabular">{formatPaise(l.paise)}</TableCell>
        </TableRow>
      ))}
    </>
  );
  const csv = () => [
    [t('ledger.cashflow.line'), t('ledger.amount')],
    [t('ledger.cashflow.netProfit'), rupees(c.netProfitPaise)],
    [t('ledger.cashflow.operating'), rupees(c.operatingPaise)],
    ...c.operating.map((l) => [`  ${l.label}`, rupees(l.paise)]),
    [t('ledger.cashflow.investing'), rupees(c.investingPaise)],
    [t('ledger.cashflow.financing'), rupees(c.financingPaise)],
    [t('ledger.cashflow.opening'), rupees(c.openingCashPaise)],
    [t('ledger.cashflow.change'), rupees(c.netChangePaise)],
    [t('ledger.cashflow.closing'), rupees(c.closingCashPaise)],
  ];
  return (
    <div className="flex flex-col gap-2" data-testid="ledger-cashflow">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{t('ledger.cashflow.help')}</p>
        <ExportPrint name={`Cash_flow_${from}_${to}`} rows={csv} testId="cashflow-export" />
      </div>
      <Table>
        <TableBody>
          <TableRow className="font-medium">
            <TableCell>{t('ledger.cashflow.netProfit')}</TableCell>
            <TableCell className="text-right tabular">{formatPaise(c.netProfitPaise)}</TableCell>
          </TableRow>
          {section(t('ledger.cashflow.operating'), c.operating, c.operatingPaise)}
          {section(t('ledger.cashflow.investing'), c.investing, c.investingPaise)}
          {section(t('ledger.cashflow.financing'), c.financing, c.financingPaise)}
          <TableRow>
            <TableCell>{t('ledger.cashflow.opening')}</TableCell>
            <TableCell className="text-right tabular">{formatPaise(c.openingCashPaise)}</TableCell>
          </TableRow>
          <TableRow className="font-semibold">
            <TableCell>{t('ledger.cashflow.change')}</TableCell>
            <TableCell className="text-right tabular">{formatPaise(c.netChangePaise)}</TableCell>
          </TableRow>
          <TableRow className="font-semibold" data-testid="cashflow-closing">
            <TableCell>{t('ledger.cashflow.closing')}</TableCell>
            <TableCell className="text-right tabular">{formatPaise(c.closingCashPaise)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p className="text-xs" data-ties={c.differencePaise === 0n ? 'yes' : 'no'}>
        {c.differencePaise === 0n
          ? t('ledger.bs.ties')
          : t('ledger.bs.difference', { amount: formatPaise(c.differencePaise) })}
      </p>
    </div>
  );
}

function DayBookTab({ from, to, shell }: { from: string; to: string; shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const book = useLiveQuery({
    tables: TABLES,
    key: ['daybook', from, to],
    fn: (d, c) => new LedgerReports(d).dayBook(c, { from, to }),
  });
  if (!book.data) return <p className="text-fg-muted">{t('empty.loading')}</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="ledger-daybook">
      <p className="text-sm text-fg-muted">
        {t('ledger.daybook.help', { count: book.data.length })}
      </p>
      {book.data.map((e, i) => (
        <Card key={i} className="p-2 text-sm" data-testid="daybook-entry">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular">{e.date}</span>
            {e.source.kind === 'document' ? (
              <button
                type="button"
                className="underline"
                onClick={() => navigate(editorPath(shell), { id: (e.source as { id: string }).id })}
              >
                {refOf(e.source)}
              </button>
            ) : (
              <span>{refOf(e.source)}</span>
            )}
            <span className="text-fg-muted">{e.narration}</span>
            <span className="ml-auto tabular">{formatPaise(e.totalPaise)}</span>
          </div>
          <ul className="pl-4 text-xs text-fg-muted">
            {e.lines.map((l, j) => (
              <li key={j}>
                {l.code} {l.name}:{' '}
                {l.debitPaise
                  ? `${t('ledger.dr')} ${formatPaise(l.debitPaise)}`
                  : `${t('ledger.cr')} ${formatPaise(l.creditPaise)}`}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------------------- year end */

function YearEndTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const confirm = useConfirm();
  const accounts = useAccounts();
  const years = useLiveQuery<FiscalYearView[]>({
    tables: TABLES,
    key: ['years'],
    fn: (d, c) => new FiscalYearRepo(d).years(c),
  });
  const [audit, setAudit] = useState<LedgerVerification | null>(null);
  const [opening, setOpening] = useState<{
    fyStart: string;
    values: Record<string, string>;
  } | null>(null);
  if (!database || !ctx) return null;
  const fyRepo = new FiscalYearRepo(database);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(t(dyn(ok)));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const close = async (y: FiscalYearView) => {
    if (
      !(await confirm({
        title: t('ledger.yearend.closeConfirm', { label: y.label }),
        description: t('ledger.yearend.closeHelp'),
      }))
    )
      return;
    await run(() => fyRepo.close(ctx, y.fyStart), 'ledger.yearend.closed');
  };
  const reopen = async (y: FiscalYearView) => {
    const reason = window.prompt(t('ledger.yearend.reopenReason'));
    if (!reason) return;
    await run(() => fyRepo.reopen(ctx, y.fyStart, reason), 'ledger.yearend.reopened');
  };
  const verify = async () => {
    try {
      setAudit(await new LedgerAudit(database).verify(ctx, todayIso()));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const repair = async () => {
    try {
      const r = await new LedgerAudit(database).repair(ctx, todayIso());
      toast.success(t('ledger.yearend.repaired', { documents: r.documents, payments: r.payments }));
      setAudit(await new LedgerAudit(database).verify(ctx, todayIso()));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const reclass = async (y: FiscalYearView) => {
    await run(
      () => new LedgerAudit(database).reclassifyTaxHeads(ctx, y.fyStart, y.fyEnd),
      'ledger.yearend.reclassified',
    );
  };
  const saveOpening = async () => {
    if (!opening) return;
    const lines: VoucherLineInput[] = Object.entries(opening.values)
      .filter(([, v]) => v && Number(v) !== 0)
      .map(([accountId, v]) => {
        const paise = parsePaise(v);
        const a = accounts.data?.find((x) => x.id === accountId);
        const dr = a && (a.type === 'asset' || a.type === 'expense');
        return {
          accountId,
          debitPaise: dr ? (paise > 0n ? paise : 0n) : paise < 0n ? -paise : 0n,
          creditPaise: dr ? (paise < 0n ? -paise : 0n) : paise > 0n ? paise : 0n,
        };
      });
    await run(
      () => new JournalRepo(database).setOpening(ctx, opening.fyStart, lines),
      'ledger.yearend.openingSaved',
    );
    setOpening(null);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="ledger-yearend">
      <Card className="p-3">
        <h2 className="pb-2 font-medium">{t('ledger.yearend.years')}</h2>
        <ul className="flex flex-col gap-2 text-sm">
          {(years.data ?? []).map((y) => (
            <li
              key={y.fyStart}
              className="flex flex-wrap items-center gap-2"
              data-testid="year-row"
              data-status={y.status}
            >
              <span className="font-medium">{y.label}</span>
              <span className="text-fg-muted">
                {y.fyStart} – {y.fyEnd} · {t('ledger.yearend.entries', { count: y.entries })}
              </span>
              <Badge tone={y.status === 'closed' ? 'success' : 'neutral'}>
                {t(dyn(`ledger.yearend.status.${y.status}`))}
              </Badge>
              {y.status === 'open' ? (
                <Button variant="outline" onClick={() => void close(y)} data-testid="year-close">
                  {t('ledger.yearend.close')}
                </Button>
              ) : (
                <Button variant="outline" onClick={() => void reopen(y)} data-testid="year-reopen">
                  {t('ledger.yearend.reopen')}
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() => setOpening({ fyStart: y.fyStart, values: {} })}
                data-testid="year-opening"
              >
                {t('ledger.yearend.opening')}
              </Button>
              <Button variant="ghost" onClick={() => void reclass(y)}>
                {t('ledger.yearend.reclass')}
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-3">
        <h2 className="pb-2 font-medium">{t('ledger.yearend.audit')}</h2>
        <p className="text-sm text-fg-muted">{t('ledger.yearend.auditHelp')}</p>
        <div className="flex gap-2 py-2">
          <Button variant="outline" onClick={() => void verify()} data-testid="audit-verify">
            {t('ledger.yearend.verify')}
          </Button>
          {audit && (audit.documents.missing.length > 0 || audit.payments.missing.length > 0) && (
            <Button onClick={() => void repair()} data-testid="audit-repair">
              {t('ledger.yearend.repair')}
            </Button>
          )}
        </div>
        {audit && (
          <ul className="text-sm" data-testid="audit-result">
            <li>
              {t('ledger.yearend.auditDocs', {
                checked: audit.documents.checked,
                missing: audit.documents.missing.length,
                unbalanced: audit.documents.unbalanced.length,
              })}
            </li>
            <li>
              {t('ledger.yearend.auditPays', {
                checked: audit.payments.checked,
                missing: audit.payments.missing.length,
              })}
            </li>
            <li>
              {t('ledger.yearend.auditVouchers', {
                checked: audit.vouchers.checked,
                unbalanced: audit.vouchers.unbalanced.length,
              })}
            </li>
            <li
              data-testid="audit-control"
              data-ties={audit.control.differencePaise === 0n ? 'yes' : 'no'}
            >
              {t('ledger.yearend.auditControl', {
                ledger: formatPaise(audit.control.ledgerNetPaise),
                parties: formatPaise(audit.control.partiesNetPaise),
                difference: formatPaise(audit.control.differencePaise),
              })}
            </li>
            {(audit.legacyTax.outputPaise !== 0n || audit.legacyTax.inputPaise !== 0n) && (
              <li>
                {t('ledger.yearend.legacyTax', {
                  output: formatPaise(audit.legacyTax.outputPaise),
                  input: formatPaise(audit.legacyTax.inputPaise),
                })}
              </li>
            )}
          </ul>
        )}
      </Card>
      {opening && accounts.data && (
        <Dialog open onOpenChange={(o) => !o && setOpening(null)}>
          <DialogContent className="max-w-2xl" data-testid="opening-dialog">
            <DialogTitle>{t('ledger.yearend.openingTitle', { date: opening.fyStart })}</DialogTitle>
            <p className="text-sm text-fg-muted">{t('ledger.yearend.openingHelp')}</p>
            <div className="max-h-96 overflow-auto">
              {accounts.data
                .filter((a) => a.type === 'asset' || a.type === 'liability' || a.type === 'equity')
                .map((a) => (
                  <label
                    key={a.id}
                    className="flex items-center justify-between gap-2 py-1 text-sm"
                  >
                    <span>
                      {a.code} {a.name}
                    </span>
                    <Input
                      type="number"
                      step="0.01"
                      className="w-40 text-right"
                      value={opening.values[a.id] ?? ''}
                      onChange={(e) =>
                        setOpening({
                          ...opening,
                          values: { ...opening.values, [a.id]: e.target.value },
                        })
                      }
                      data-testid={`opening-${a.code}`}
                    />
                  </label>
                ))}
            </div>
            <div className="flex justify-end">
              <Button onClick={() => void saveOpening()} data-testid="opening-save">
                {t('ledger.chart.save')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      <Textarea className="hidden" readOnly value="" aria-hidden />
    </div>
  );
}

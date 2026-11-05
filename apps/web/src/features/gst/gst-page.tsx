import type { FilingRecord } from '@gst/db';
import {
  ITC_FIELDS,
  parseAmountPaise,
  today,
  type GstrIssue,
  type GstrPeriod,
  type PeriodReview,
  type Return,
} from '@gst/domain';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  MoneyText,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useAdjustments,
  useBusinessGst,
  useFilingKind,
  useFilings,
  useGstActions,
  useReview,
} from './hooks';
import { cardState, gstr1Rows, periodLabel, recentPeriods, type CardState } from './model';
import { ReconcileTab } from './reconcile-tab';

import { useAppNavigate } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { dyn } from '@/lib/dyn-key';

const TONE: Record<string, 'neutral' | 'info' | 'accent' | 'success' | 'danger'> = {
  not_started: 'neutral',
  ready: 'info',
  exported: 'accent',
  filed: 'success',
  late: 'danger',
};

/** Put the cursor in a dialog's first field when it opens, so a person can type straight away. */
const focusOnMount = (el: HTMLElement | null) => {
  if (el) requestAnimationFrame(() => el.focus());
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Eagerly work out only the newest periods; older ones are worked out when opened. */
const EAGER = 3;

/** The Filing Desk: one row per period, with the status of GSTR-1 and GSTR-3B, and a review below it. */
export function GstPage({ shell }: { shell: Shell }) {
  void shell;
  const { t, i18n } = useTranslation();
  const biz = useBusinessGst();
  const { kind, set } = useFilingKind();
  const filings = useFilings();
  const [open, setOpen] = useState<string | null>(null);
  const day = today(() => new Date());

  const gstin = biz?.gstin ?? '';
  const periods = gstin ? recentPeriods(gstin, day, kind) : [];

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHeader
        title={t('gst.title')}
        description={t('gst.subtitle')}
        actions={
          <label className="flex items-center gap-2 text-sm">
            <span>{t('gst.frequency')}</span>
            <Select
              value={kind}
              onValueChange={(v) => void set(v === 'quarter' ? 'quarter' : 'month')}
            >
              <SelectTrigger className="w-44" aria-label={t('gst.frequency')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">{t('gst.monthly')}</SelectItem>
                <SelectItem value="quarter">{t('gst.quarterly')}</SelectItem>
              </SelectContent>
            </Select>
          </label>
        }
      />
      <p role="note" className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
        {t('gst.beta')}
      </p>
      {biz && biz.scheme === 'composition' ? (
        <p role="note" className="text-sm">
          {t('gst.composition')}
        </p>
      ) : null}
      {biz && !biz.gstin ? (
        <EmptyState title={t('gst.noGstin')} />
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t('gst.title')}>
          {periods.map((p, i) => (
            <PeriodRow
              key={`${p.kind}-${p.fp}`}
              period={p}
              stateCode={biz?.stateCode ?? ''}
              filings={filings}
              eager={i < EAGER}
              open={open === p.fp}
              onToggle={() => setOpen(open === p.fp ? null : p.fp)}
              locale={i18n.language}
              today={day}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PeriodRow(props: {
  period: GstrPeriod;
  stateCode: string;
  filings: FilingRecord[];
  eager: boolean;
  open: boolean;
  onToggle: () => void;
  locale: string;
  today: string;
}) {
  const { t } = useTranslation();
  const { period, filings } = props;
  const review = useReview(period, props.eager || props.open);
  const find = (ret: Return) =>
    filings.find((f) => f.returnType === ret && f.fp === period.fp) ?? null;
  const cards = (['gstr1', 'gstr3b'] as const).map((ret) => ({
    ret,
    state: cardState({
      ret,
      period,
      stateCode: props.stateCode,
      filing: find(ret),
      review: review.data ?? null,
      today: props.today,
    }),
  }));
  const label = periodLabel(period, props.locale);
  const regionId = `gst-detail-${period.fp}-${period.kind}`;

  return (
    <li>
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-4">
          <h2 className="min-w-28 text-base font-semibold">{label}</h2>
          {cards.map(({ ret, state }) => (
            <div key={ret} className="flex min-w-52 flex-col gap-1 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{t(`gst.${ret}`)}</span>
                <Badge tone={TONE[state.status]}>{t(dyn(`gst.status.${state.status}`))}</Badge>
              </div>
              <span className="text-fg-muted">
                {state.overridden
                  ? t('gst.dueSet', { date: state.due })
                  : t('gst.due', { date: state.due })}
              </span>
              {state.filing?.status === 'filed' ? (
                <span className="text-fg-muted">
                  {t('gst.file.filedLine', { date: state.filing.filedOn, arn: state.filing.arn })}
                </span>
              ) : null}
            </div>
          ))}
          <div className="ml-auto flex flex-col items-end gap-1 text-sm">
            {review.data && !review.data.hasDocuments ? (
              <span className="text-fg-muted">{t('gst.noDocuments')}</span>
            ) : review.data && review.data.blockers > 0 ? (
              <Badge tone="warning">{t('gst.blockers', { count: review.data.blockers })}</Badge>
            ) : null}
            <Button
              variant="secondary"
              aria-expanded={props.open}
              aria-controls={regionId}
              onClick={props.onToggle}
            >
              {props.open ? t('gst.hide') : t('gst.review')}
            </Button>
          </div>
        </div>
        {props.open ? (
          <div
            id={regionId}
            role="region"
            aria-label={label}
            className="mt-4 border-t border-border pt-4"
          >
            {review.data ? (
              <Detail review={review.data} cards={cards} />
            ) : (
              <p>{t('gst.loading')}</p>
            )}
          </div>
        ) : null}
      </Card>
    </li>
  );
}

function Detail({
  review,
  cards,
}: {
  review: PeriodReview;
  cards: { ret: Return; state: CardState }[];
}) {
  const { t } = useTranslation();
  return (
    <Tabs defaultValue="gstr1">
      <TabsList>
        <TabsTrigger value="gstr1">{t('gst.tabs.gstr1')}</TabsTrigger>
        <TabsTrigger value="gstr3b">{t('gst.tabs.gstr3b')}</TabsTrigger>
        <TabsTrigger value="recon">{t('gst.tabs.recon')}</TabsTrigger>
        <TabsTrigger value="checks">
          {t('gst.tabs.checks')}
          {review.blockers > 0 ? ` (${review.blockers})` : ''}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="gstr1">
        <Gstr1Tab review={review} card={cards.find((c) => c.ret === 'gstr1')!.state} />
      </TabsContent>
      <TabsContent value="gstr3b">
        <Gstr3bTab review={review} card={cards.find((c) => c.ret === 'gstr3b')!.state} />
      </TabsContent>
      <TabsContent value="recon">
        <ReconcileTab period={review.period} />
      </TabsContent>
      <TabsContent value="checks">
        <Checks issues={review.issues} fp={review.period.fp} blockers={review.blockers} />
      </TabsContent>
    </Tabs>
  );
}

function ExportBar({ ret, review, card }: { ret: Return; review: PeriodReview; card: CardState }) {
  const { t } = useTranslation();
  const actions = useGstActions();
  const [filing, setFiling] = useState(false);
  const [reopening, setReopening] = useState(false);
  const run = async (which: 'json' | 'csv') => {
    try {
      await actions.exportFiles(ret, review, which);
      toast.success(t('gst.export.done'));
    } catch (e) {
      toast.error(errText(e));
    }
  };
  const filed = card.filing?.status === 'filed';
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Button disabled={review.blockers > 0} onClick={() => void run('json')}>
        {t('gst.export.json')}
      </Button>
      {ret === 'gstr1' ? (
        <Button variant="secondary" disabled={review.blockers > 0} onClick={() => void run('csv')}>
          {t('gst.export.csv')}
        </Button>
      ) : null}
      {filed ? (
        <Button variant="secondary" onClick={() => setReopening(true)}>
          {t('gst.file.reopen')}
        </Button>
      ) : (
        <Button variant="secondary" onClick={() => setFiling(true)}>
          {t('gst.file.mark')}
        </Button>
      )}
      {review.blockers > 0 ? (
        <span className="text-sm text-fg-muted" data-testid="export-blocked">
          {t('gst.export.blocked', { count: review.blockers })}
        </span>
      ) : null}
      {filing ? (
        <FileDialog ret={ret} period={review.period} onClose={() => setFiling(false)} />
      ) : null}
      {reopening ? (
        <ReopenDialog ret={ret} period={review.period} onClose={() => setReopening(false)} />
      ) : null}
    </div>
  );
}

function FileDialog({
  ret,
  period,
  onClose,
}: {
  ret: Return;
  period: GstrPeriod;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const actions = useGstActions();
  const [arn, setArn] = useState('');
  const [filedOn, setFiledOn] = useState(today(() => new Date()));
  const [lock, setLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await actions.markFiled(ret, period, { arn, filedOn }, lock);
      toast.success(t('gst.file.done'));
      onClose();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog open onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialogContent>
        <AlertDialogTitle>{t('gst.file.title', { ret: t(`gst.${ret}`) })}</AlertDialogTitle>
        <AlertDialogDescription className="sr-only">{t('gst.file.mark')}</AlertDialogDescription>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {t('gst.file.arn')}
            <Input value={arn} onChange={(e) => setArn(e.target.value)} ref={focusOnMount} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('gst.file.date')}
            <Input type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={lock} onCheckedChange={(v) => setLock(v === true)} />
            {t('gst.file.lock', { date: period.to })}
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('gst.file.cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {t('gst.file.save')}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ReopenDialog({
  ret,
  period,
  onClose,
}: {
  ret: Return;
  period: GstrPeriod;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const actions = useGstActions();
  const [reason, setReason] = useState('');
  const save = async () => {
    try {
      await actions.reopen(ret, period, reason);
      toast.success(t('gst.file.reopened'));
      onClose();
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <AlertDialog open onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialogContent>
        <AlertDialogTitle>{t('gst.file.reopen')}</AlertDialogTitle>
        <AlertDialogDescription className="sr-only">
          {t('gst.file.reopenWhy')}
        </AlertDialogDescription>
        <label className="flex flex-col gap-1 text-sm">
          {t('gst.file.reopenWhy')}
          <Input value={reason} onChange={(e) => setReason(e.target.value)} ref={focusOnMount} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('gst.file.cancel')}
          </Button>
          <Button onClick={() => void save()}>{t('gst.file.reopenSave')}</Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Gstr1Tab({ review, card }: { review: PeriodReview; card: CardState }) {
  const { t } = useTranslation();
  const rows = gstr1Rows(review);
  return (
    <div>
      <ExportBar ret="gstr1" review={review} card={card} />
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>{t('gst.col.table')}</TableHeaderCell>
            <TableHeaderCell className="text-right">{t('gst.col.count')}</TableHeaderCell>
            <TableHeaderCell className="text-right">{t('gst.col.taxable')}</TableHeaderCell>
            <TableHeaderCell className="text-right">{t('gst.col.tax')}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell>{t(`gst.tables.${r.key}`)}</TableCell>
              <TableCell className="text-right tabular">{r.count}</TableCell>
              <TableCell className="text-right">
                {r.taxable === null ? null : <MoneyText paise={r.taxable} />}
              </TableCell>
              <TableCell className="text-right">
                {r.tax === null ? null : <MoneyText paise={r.tax} />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Gstr3bTab({ review, card }: { review: PeriodReview; card: CardState }) {
  const { t } = useTranslation();
  const g = review.gstr3b;
  const money = (p: number) => <MoneyText paise={p} negativeRed />;
  const taxRow = (
    key: string,
    label: string,
    v: { txval?: number; iamt: number; camt: number; samt: number; csamt: number },
  ) => (
    <TableRow key={key}>
      <TableCell>{label}</TableCell>
      <TableCell className="text-right">{v.txval === undefined ? null : money(v.txval)}</TableCell>
      <TableCell className="text-right">{money(v.iamt)}</TableCell>
      <TableCell className="text-right">{money(v.camt)}</TableCell>
      <TableCell className="text-right">{money(v.samt)}</TableCell>
      <TableCell className="text-right">{money(v.csamt)}</TableCell>
    </TableRow>
  );
  const avail = (
    [
      'availableImportGoods',
      'availableImportServices',
      'availableReverseCharge',
      'availableIsd',
      'availableOther',
    ] as const
  ).reduce(
    (a, k) => ({
      iamt: a.iamt + g.s4[k].iamt,
      camt: a.camt + g.s4[k].camt,
      samt: a.samt + g.s4[k].samt,
      csamt: a.csamt + g.s4[k].csamt,
    }),
    { iamt: 0, camt: 0, samt: 0, csamt: 0 },
  );
  const rev = {
    iamt: g.s4.reversedRules.iamt + g.s4.reversedOther.iamt,
    camt: g.s4.reversedRules.camt + g.s4.reversedOther.camt,
    samt: g.s4.reversedRules.samt + g.s4.reversedOther.samt,
    csamt: g.s4.reversedRules.csamt + g.s4.reversedOther.csamt,
  };
  return (
    <div className="flex flex-col gap-6">
      <div>
        <ExportBar ret="gstr3b" review={review} card={card} />
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{t('gst.s3b.row')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('gst.s3b.taxable')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('gst.s3b.igst')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('gst.s3b.cgst')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('gst.s3b.sgst')}</TableHeaderCell>
              <TableHeaderCell className="text-right">{t('gst.s3b.cess')}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {taxRow('a', t('gst.s3b.outward'), g.s31.a)}
            {taxRow('b', t('gst.s3b.zero'), g.s31.b)}
            {taxRow('c', t('gst.s3b.nil'), {
              txval: g.s31.c.txval,
              iamt: 0,
              camt: 0,
              samt: 0,
              csamt: 0,
            })}
            {taxRow('d', t('gst.s3b.rcm'), g.s31.d)}
            {taxRow('e', t('gst.s3b.nonGst'), {
              txval: g.s31.e.txval,
              iamt: 0,
              camt: 0,
              samt: 0,
              csamt: 0,
            })}
            {taxRow('avail', t('gst.s3b.itcAvailable'), avail)}
            {taxRow('rev', t('gst.s3b.itcReversed'), rev)}
            {taxRow('net', t('gst.s3b.itcNet'), g.s4.net)}
            {taxRow('cash', t('gst.s3b.cash'), g.s61.cashPayable)}
          </TableBody>
        </Table>
        <p className="mt-2 text-sm text-fg-muted">{t('gst.s3b.estimate')}</p>
      </div>
      <Adjustments fp={review.period.fp} />
    </div>
  );
}

function Adjustments({ fp }: { fp: string }) {
  const { t } = useTranslation();
  const actions = useGstActions();
  const list = useAdjustments(fp);
  const [field, setField] = useState<string>('reversedOther');
  const [amt, setAmt] = useState({ i: '', c: '', s: '', k: '' });
  const [reason, setReason] = useState('');
  const parse = (v: string): number | null => {
    if (v.trim() === '') return 0;
    const p = parseAmountPaise(v, { allowNegative: true });
    return p === undefined || p === null ? null : p;
  };
  const add = async () => {
    const iamt = parse(amt.i);
    const camt = parse(amt.c);
    const samt = parse(amt.s);
    const csamt = parse(amt.k);
    if (iamt === null || camt === null || samt === null || csamt === null) {
      toast.error(t('gst.adjust.badAmount'));
      return;
    }
    try {
      await actions.addAdjustment(fp, { field: `itc.${field}`, iamt, camt, samt, csamt, reason });
      toast.success(t('gst.adjust.added'));
      setAmt({ i: '', c: '', s: '', k: '' });
      setReason('');
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <section aria-labelledby={`adj-${fp}`} className="flex flex-col gap-3">
      <h3 id={`adj-${fp}`} className="text-base font-semibold">
        {t('gst.adjust.title')}
      </h3>
      <p className="text-sm text-fg-muted">{t('gst.adjust.hint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {t('gst.adjust.field')}
          <Select value={field} onValueChange={setField}>
            <SelectTrigger className="w-72" aria-label={t('gst.adjust.field')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ITC_FIELDS.map((f) => (
                <SelectItem key={f} value={f}>
                  {t(dyn(`gst.adjust.fields.${f}`))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {(
          [
            ['i', 'gst.s3b.igst'],
            ['c', 'gst.s3b.cgst'],
            ['s', 'gst.s3b.sgst'],
            ['k', 'gst.s3b.cess'],
          ] as const
        ).map(([k, key]) => (
          <label key={k} className="flex flex-col gap-1 text-sm">
            {t(key)}
            <Input
              className="w-28 text-right"
              inputMode="decimal"
              value={amt[k]}
              onChange={(e) => setAmt({ ...amt, [k]: e.target.value })}
            />
          </label>
        ))}
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm">
          {t('gst.adjust.reason')}
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <Button onClick={() => void add()}>{t('gst.adjust.add')}</Button>
      </div>
      <div>
        <h4 className="mb-1 text-sm font-medium">{t('gst.adjust.list')}</h4>
        {list.data && list.data.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {list.data.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {t(dyn(`gst.adjust.fields.${a.field.replace(/^itc\./, '')}`))}
                </span>
                <MoneyText paise={a.iamt + a.camt + a.samt + a.csamt} negativeRed />
                <span className="text-fg-muted">{a.reason}</span>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void actions
                      .removeAdjustment(a.id, a.version)
                      .then(() => toast.success(t('gst.adjust.removed')))
                      .catch((e: unknown) => toast.error(errText(e)))
                  }
                >
                  {t('gst.adjust.remove')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">{t('gst.adjust.none')}</p>
        )}
      </div>
    </section>
  );
}

function Checks({ issues, fp, blockers }: { issues: GstrIssue[]; fp: string; blockers: number }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const actions = useGstActions();
  const [asking, setAsking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  if (issues.length === 0) return <p>{t('gst.checks.none')}</p>;
  const save = async (key: string) => {
    try {
      await actions.acknowledge(fp, key, reason);
      toast.success(t('gst.checks.ackDone'));
      setAsking(null);
      setReason('');
    } catch (e) {
      toast.error(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {blockers > 0 ? (
        <p role="status" className="text-sm" data-testid="checks-summary">
          {t('gst.checks.summary', { count: blockers })}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {issues.map((i) => (
          <li key={i.key} className="flex flex-col gap-1 text-sm" data-testid="issue">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={i.severity === 'error' ? 'danger' : 'warning'}>
                {i.severity === 'error' ? t('gst.checks.error') : t('gst.checks.warning')}
              </Badge>
              <span>{i.message}</span>
              {i.docId ? (
                <Button
                  variant="ghost"
                  onClick={() => navigate('/books/documents/new', { id: i.docId })}
                >
                  {t('gst.checks.open')}
                </Button>
              ) : null}
              {i.acknowledged ? null : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAsking(asking === i.key ? null : (i.key ?? null));
                    setReason('');
                  }}
                >
                  {t('gst.checks.ack')}
                </Button>
              )}
            </div>
            {i.acknowledged ? (
              <div className="flex flex-wrap items-center gap-2 text-fg-muted">
                <span>{t('gst.checks.acked', { reason: i.acknowledged })}</span>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void actions
                      .unacknowledge(fp, i.key!)
                      .then(() => toast.success(t('gst.checks.ackRemoved')))
                      .catch((e: unknown) => toast.error(errText(e)))
                  }
                >
                  {t('gst.checks.takeBack')}
                </Button>
              </div>
            ) : null}
            {asking === i.key ? (
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-72 flex-1 flex-col gap-1">
                  {t('gst.checks.ackReason')}
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    ref={focusOnMount}
                  />
                </label>
                <Button onClick={() => void save(i.key!)}>{t('gst.checks.ackSave')}</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

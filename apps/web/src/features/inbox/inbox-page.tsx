import { BULK_MIN_CONFIDENCE, SNOOZE_PRESETS } from '@gst/ai';
import { acceptReviewItems, applyReviewItem, bulkCandidates, rejectReviewItem } from '@gst/ai/db';
import { ReviewRepo } from '@gst/db';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Badge,
  Button,
  Card,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cn,
  toast,
} from '@gst/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AutoRulesDialog } from './auto-rules';
import { saveAutoRules, useAutoRules, useInbox } from './hooks';
import { runChecks } from './hooks';
import { checkInputs } from './jobs';
import {
  canAccept,
  describeArgs,
  diffLines,
  editableFields,
  filterRows,
  headline,
  kindInfo,
  openTarget,
  whatsappUrl,
  type InboxRow,
} from './model';

import { useAppDb } from '@/app/db';
import { useLocationInfo } from '@/app/hooks';
import { useAppNavigate } from '@/app/hooks';
import { isTypingTarget } from '@/app/shortcuts';
import type { Shell } from '@/app/store';
import { ExtractionDetail, ExtractionEditDialog } from '@/features/ai/extraction-detail';
import { ScanPanel } from '@/features/ai/scan-panel';
import { useFeatureFlags } from '@/features/business/hooks';
import { SyncConflictDetail } from '@/features/sync/conflict-detail';
import { ApprovalDetail } from '@/features/team/approval-detail';
import { track } from '@/features/telemetry/telemetry';
import { dyn } from '@/lib/dyn-key';
import { useTerm } from '@/lib/terms';

type View = 'open' | 'snoozed' | 'done';

const ROW_BOOKS = 56;
const ROW_SHOP = 132;

const KIND_TONE: Record<string, 'info' | 'warning' | 'danger' | 'neutral' | 'accent'> = {
  duplicate_party: 'warning',
  duplicate_item: 'warning',
  hsn_suggestion: 'info',
  rate_change: 'accent',
  reminder_due: 'accent',
  low_stock: 'warning',
  expiry_due: 'warning',
  draft_stale: 'neutral',
  backup_failed: 'danger',
  prefiling_issue: 'warning',
  gsp_job_stopped: 'warning',
};

/** Put the cursor in a dialog's first field when it opens, so a person can type straight away. */
const focusOnMount = (el: HTMLElement | null) => {
  if (el) requestAnimationFrame(() => el.focus());
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The review inbox: what the app noticed, for a person to accept, change, reject or put off. */
export function InboxPage({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const flags = useFeatureFlags();
  const navigate = useAppNavigate();
  const inbox = useInbox();
  const rules = useAutoRules();

  const [view, setView] = useState<View>('open');
  const { search: location } = useLocationInfo();
  const [scanning, setScanning] = useState(() => location['intent'] === 'scan');
  const [kind, setKind] = useState('all');
  const [search, setSearch] = useState('');
  const [index, setIndex] = useState(0);
  const [reject, setReject] = useState<InboxRow | null>(null);
  const [edit, setEdit] = useState<InboxRow | null>(null);
  const [bulk, setBulk] = useState(false);
  const [auto, setAuto] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);

  const lists = inbox.data;
  const rows = useMemo(
    () => filterRows(lists?.[view] ?? [], { kind, search }),
    [lists, view, kind, search],
  );
  const current = rows.length > 0 ? rows[Math.min(index, rows.length - 1)]! : null;
  const kinds = useMemo(
    () => [...new Set((lists?.[view] ?? []).map((r) => r.kind))].sort(),
    [lists, view],
  );
  // the button shows whenever something could be accepted in bulk; the dialog's bar decides what is offered
  const bulkRows = useMemo(
    () =>
      bulkCandidates(
        (lists?.open ?? []).map((r) => r.row),
        0,
      ),
    [lists],
  );

  const rowHeight = shell === 'shop' ? ROW_SHOP : ROW_BOOKS;
  const scroller = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });
  const at = rows.length > 0 ? Math.min(index, rows.length - 1) : 0;
  useEffect(() => {
    if (rows.length > 0) virt.scrollToIndex(at, { align: 'auto' });
    // scrolling is the only effect; the virtualizer object changes every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, rows.length]);

  const guard = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(t('inbox.toast.failed', { message: errText(e) }));
    } finally {
      setBusy(false);
    }
  };

  const accept = (r: InboxRow, edited?: unknown) =>
    guard(async () => {
      if (!database || !ctx) return;
      await applyReviewItem(database, ctx, r.row, edited);
      toast.success(
        t(kindInfo(r.kind)?.informational ? 'inbox.toast.acknowledged' : 'inbox.toast.accepted'),
      );
      track('inbox_accepted');
    });

  const doReject = (r: InboxRow, reason: string) =>
    guard(async () => {
      if (!database || !ctx) return;
      await rejectReviewItem({
        db: database,
        ctx,
        id: r.id,
        expectedVersion: r.version,
        reason,
      });
      toast(t('inbox.toast.rejected'));
      track('inbox_rejected');
      setReject(null);
    });

  const snooze = (r: InboxRow, ms: number) =>
    guard(async () => {
      if (!database || !ctx) return;
      await new ReviewRepo(database).snooze(ctx, r.id, Date.now() + ms, r.version);
      toast(t('inbox.toast.snoozed'));
    });

  const unsnooze = (r: InboxRow) =>
    guard(async () => {
      if (!database || !ctx) return;
      await new ReviewRepo(database).unsnooze(ctx, r.id, r.version);
      toast(t('inbox.toast.unsnoozed'));
    });

  const open = (r: InboxRow) => {
    const target = openTarget(r);
    if (!target) return;
    if (target.to === 'document')
      navigate(shell === 'shop' ? '/shop/sell' : '/books/documents/new', target.search);
    else navigate(`/${shell}/${target.to}`, target.search);
  };

  const check = async () => {
    if (!database || !ctx || checking) return;
    setChecking(true);
    try {
      const r = await runChecks(database, ctx, checkInputs(!!flags.inventory));
      toast(
        r.created > 0
          ? t('inbox.toast.checked', { count: r.created })
          : t('inbox.toast.nothingNew'),
      );
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setChecking(false);
    }
  };

  const onKeyDown = (e: globalThis.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || reject || edit || bulk || auto) return;
    const key = e.key.toLowerCase();
    if (key === 'j' || key === 'arrowdown') {
      e.preventDefault();
      setIndex(Math.min(at + 1, Math.max(rows.length - 1, 0)));
    } else if (key === 'k' || key === 'arrowup') {
      e.preventDefault();
      setIndex(Math.max(at - 1, 0));
    } else if (!current) {
      return;
    } else if (key === 'a' && view === 'open' && canAccept(current)) {
      e.preventDefault();
      void accept(current);
    } else if (key === 'r' && view === 'open') {
      e.preventDefault();
      setReject(current);
    } else if (key === 'e' && view === 'open' && editableFields(current.kind).length > 0) {
      e.preventDefault();
      setEdit(current);
    } else if (key === 's' && view === 'open') {
      e.preventDefault();
      setSnoozeOpen(true);
    } else if (key === 'o') {
      e.preventDefault();
      open(current);
    }
  };

  // the keys work anywhere on the page (not only while the list has focus), so a click on a button
  // does not stop A / R / J / K from working
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const counts = {
    open: lists?.open.length ?? 0,
    snoozed: lists?.snoozed.length ?? 0,
    done: lists?.done.length ?? 0,
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col outline-none"
      data-testid="inbox"
      aria-label={t('inbox.title')}
    >
      <PageHeader
        title={t('inbox.title')}
        description={t('inbox.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {bulkRows.length > 0 && (
              <Button variant="secondary" data-testid="inbox-bulk" onClick={() => setBulk(true)}>
                {t('inbox.actions.bulk')}
              </Button>
            )}
            <Button
              variant="secondary"
              data-testid="inbox-scan"
              onClick={() => setScanning((v) => !v)}
            >
              {t('ai.scan.title')}
            </Button>
            <Button variant="ghost" data-testid="inbox-auto" onClick={() => setAuto(true)}>
              {t('inbox.auto.title')}
            </Button>
            <Button
              variant="secondary"
              data-testid="inbox-check"
              disabled={checking}
              onClick={() => void check()}
            >
              {t('inbox.actions.runChecks')}
            </Button>
          </div>
        }
      />

      {scanning && (
        <ScanPanel
          onScanned={() => {
            setView('open');
            setKind('ai_extraction');
            setIndex(0);
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 pb-3">
        <div role="tablist" aria-label={t('inbox.title')} className="flex gap-1">
          {(['open', 'snoozed', 'done'] as const).map((v) => (
            <Button
              key={v}
              role="tab"
              aria-selected={view === v}
              variant={view === v ? 'primary' : 'ghost'}
              data-testid={`inbox-tab-${v}`}
              onClick={() => {
                setView(v);
                setKind('all');
                setIndex(0);
              }}
            >
              {t(`inbox.views.${v}`)}{' '}
              <span className="tabular-nums" data-testid={`inbox-count-${v}`}>
                {counts[v]}
              </span>
            </Button>
          ))}
        </div>
        <Select
          value={kind}
          onValueChange={(v) => {
            setKind(v);
            setIndex(0);
          }}
        >
          <SelectTrigger
            className="w-56"
            aria-label={t('inbox.filters.kind')}
            data-testid="inbox-kind"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('inbox.filters.allKinds')}</SelectItem>
            {kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {t(dyn(`inbox.kinds.${k}`))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-56"
          value={search}
          placeholder={t('inbox.filters.search')}
          aria-label={t('inbox.filters.search')}
          data-testid="inbox-search"
          onChange={(e) => {
            setSearch(e.target.value);
            setIndex(0);
          }}
        />
        <span className="ml-auto text-xs text-fg-muted" data-testid="inbox-keys">
          {t('inbox.keys')}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={t(`inbox.empty.${view}`)} />
      ) : (
        <div
          className={cn('flex min-h-0 flex-1 gap-3', shell === 'shop' && 'flex-col')}
          data-testid="inbox-body"
        >
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-auto rounded-md border border-border"
            data-testid="inbox-list"
            role={shell === 'shop' ? 'list' : 'listbox'}
            aria-label={t('inbox.title')}
          >
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {virt.getVirtualItems().map((v) => {
                const r = rows[v.index]!;
                const selected = v.index === at;
                return (
                  <div
                    key={r.id}
                    role={shell === 'shop' ? 'listitem' : 'option'}
                    {...(shell === 'shop'
                      ? { 'aria-current': selected }
                      : { 'aria-selected': selected })}
                    data-testid="inbox-row"
                    data-kind={r.kind}
                    data-selected={selected}
                    tabIndex={-1}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setIndex(v.index);
                    }}
                    className={cn(
                      'absolute inset-x-0 cursor-pointer border-b border-border px-3',
                      selected ? 'bg-surface-2' : 'hover:bg-surface-1',
                    )}
                    style={{ top: v.start, height: v.size }}
                    onClick={() => setIndex(v.index)}
                  >
                    {shell === 'shop' ? (
                      <ShopCard
                        row={r}
                        view={view}
                        busy={busy}
                        onAccept={() => void accept(r)}
                        onReject={() => setReject(r)}
                        onSnooze={(ms) => void snooze(r, ms)}
                        onUnsnooze={() => void unsnooze(r)}
                        onOpen={() => open(r)}
                      />
                    ) : (
                      <BooksRow row={r} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {shell === 'books' && current && (
            <Detail
              row={current}
              view={view}
              busy={busy}
              snoozeOpen={snoozeOpen}
              onSnoozeOpen={setSnoozeOpen}
              onAccept={() => void accept(current)}
              onEdit={() => setEdit(current)}
              onReject={() => setReject(current)}
              onSnooze={(ms) => void snooze(current, ms)}
              onUnsnooze={() => void unsnooze(current)}
              onOpen={() => open(current)}
            />
          )}
        </div>
      )}

      {reject && (
        <RejectDialog
          row={reject}
          busy={busy}
          onCancel={() => setReject(null)}
          onConfirm={(reason) => void doReject(reject, reason)}
        />
      )}
      {edit && edit.kind === 'ai_extraction' && (
        <ExtractionEditDialog
          row={edit}
          busy={busy}
          onCancel={() => setEdit(null)}
          onConfirm={(value) => {
            const r = edit;
            setEdit(null);
            void accept(r, value);
          }}
        />
      )}
      {edit && edit.kind !== 'ai_extraction' && (
        <EditDialog
          row={edit}
          busy={busy}
          onCancel={() => setEdit(null)}
          onConfirm={(value) => {
            const r = edit;
            setEdit(null);
            void accept(r, value);
          }}
        />
      )}
      {bulk && (
        <BulkDialog
          rows={filterRows(lists?.open ?? [], { kind, search }).filter(
            (r) => kindInfo(r.kind)?.bulk,
          )}
          onClose={() => setBulk(false)}
        />
      )}
      {auto && (
        <AutoRulesDialog
          value={rules.data?.hsnMinConfidence ?? null}
          onClose={() => setAuto(false)}
          onSave={async (v) => {
            if (!database || !ctx) return;
            await saveAutoRules(database, ctx, { hsnMinConfidence: v });
            setAuto(false);
          }}
        />
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const { t } = useTranslation();
  return (
    <Badge tone={KIND_TONE[kind] ?? 'neutral'} className="whitespace-nowrap">
      {t(dyn(`inbox.kinds.${kind}`))}
    </Badge>
  );
}

function summary(r: InboxRow, t: TFunction) {
  const known = kindInfo(r.kind) && !kindInfo(r.kind)!.pending;
  return known ? t(dyn(`inbox.describe.${r.kind}`), describeArgs(r)) : t('inbox.describe.generic');
}

function BooksRow({ row }: { row: InboxRow }) {
  const { t } = useTranslation();
  return (
    <div className="grid h-full grid-cols-[11rem_1fr_4rem] items-center gap-3 text-sm">
      <KindBadge kind={row.kind} />
      <div className="min-w-0">
        <div className="truncate font-medium">{headline(row)}</div>
        <div className="truncate text-xs text-fg-muted">{summary(row, t)}</div>
      </div>
      <span className="text-right text-xs tabular-nums text-fg-muted">
        {row.confidence == null ? '' : `${row.confidence}%`}
      </span>
    </div>
  );
}

function ShopCard(props: {
  row: InboxRow;
  view: View;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onSnooze: (ms: number) => void;
  onUnsnooze: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { row, view } = props;
  return (
    <div className="flex h-full flex-col justify-center gap-2 py-2">
      <div className="flex items-center gap-2">
        <KindBadge kind={row.kind} />
        <span className="truncate font-medium">{headline(row)}</span>
      </div>
      <p className="line-clamp-2 text-sm text-fg-muted">{summary(row, t)}</p>
      {view === 'open' ? (
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="card-accept"
            disabled={props.busy || !canAccept(row)}
            onClick={props.onAccept}
          >
            {t(
              kindInfo(row.kind)?.informational
                ? 'inbox.actions.acknowledge'
                : 'inbox.actions.accept',
            )}
          </Button>
          <Button variant="ghost" data-testid="card-reject" onClick={props.onReject}>
            {t('inbox.actions.reject')}
          </Button>
          <Button
            variant="ghost"
            data-testid="card-snooze"
            onClick={() => props.onSnooze(SNOOZE_PRESETS[1].ms)}
          >
            {t('inbox.actions.snooze')}
          </Button>
          {openTarget(row) && (
            <Button variant="ghost" onClick={props.onOpen}>
              {t('inbox.actions.open')}
            </Button>
          )}
        </div>
      ) : view === 'snoozed' ? (
        <Button variant="secondary" className="self-start" onClick={props.onUnsnooze}>
          {t('inbox.actions.unsnooze')}
        </Button>
      ) : (
        <StatusLine row={row} />
      )}
    </div>
  );
}

function StatusLine({ row }: { row: InboxRow }) {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-fg-muted" data-testid="inbox-status">
      {t(dyn(`inbox.status.${row.status}`))}
      {row.rejectReason ? ` · ${t('inbox.reason', { reason: row.rejectReason })}` : ''}
    </p>
  );
}

function Detail(props: {
  row: InboxRow;
  view: View;
  busy: boolean;
  snoozeOpen: boolean;
  onSnoozeOpen: (open: boolean) => void;
  onAccept: () => void;
  onEdit: () => void;
  onReject: () => void;
  onSnooze: (ms: number) => void;
  onUnsnooze: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { row, view } = props;
  const info = kindInfo(row.kind);
  const lines = diffLines(row);
  const s = row.suggestion;
  return (
    <Card className="w-96 shrink-0 overflow-auto" data-testid="inbox-detail">
      <div className="flex items-center gap-2 pb-2">
        <KindBadge kind={row.kind} />
        {row.confidence != null && <span className="text-xs text-fg-muted">{row.confidence}%</span>}
      </div>
      <h2 className="text-base font-semibold">{headline(row)}</h2>
      <p className="py-2 text-sm text-fg-muted">{summary(row, t)}</p>

      {Array.isArray(s['reasons']) && s['reasons'].length > 0 && (
        <p className="pb-2 text-xs text-fg-muted">
          {(s['reasons'] as string[])
            .map((x) => t(`inbox.reasons.${x}`, { defaultValue: x }))
            .join(' · ')}
        </p>
      )}

      {lines.length > 0 && (
        <table className="w-full pb-2 text-sm" data-testid="inbox-diff">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th className="font-normal" />
              <th className="font-normal">{t('inbox.diff.before')}</th>
              <th className="font-normal">{t('inbox.diff.after')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.label}>
                <td className="pr-2 text-fg-muted">{l.label}</td>
                <td className="pr-2 line-through decoration-danger/60">{l.before}</td>
                <td className="font-medium">{l.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {row.kind === 'ai_extraction' && <ExtractionDetail row={row} />}
      {row.kind === 'sync_conflict' && <SyncConflictDetail row={row} />}
      {row.kind === 'approval_request' && <ApprovalDetail row={row} />}

      {row.kind === 'reminder_due' && (
        <div className="py-2">
          <p className="text-xs text-fg-muted">
            {t('inbox.language', { language: String(s['language']).toUpperCase() })}
          </p>
          <p
            className="mt-1 whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-sm"
            data-testid="reminder-message"
          >
            {String(s['message'])}
          </p>
          <Button
            variant="secondary"
            className="mt-2"
            onClick={() =>
              window.open(
                whatsappUrl(s['phone'] ?? null, String(s['message'])),
                '_blank',
                'noopener',
              )
            }
          >
            {t('inbox.actions.sendReminder')}
          </Button>
        </div>
      )}

      {info?.pending && (
        <p className="py-2 text-sm text-warning-fg">{t('inbox.notYet', { when: info.pending })}</p>
      )}

      {view === 'open' && (
        <div className="flex flex-wrap gap-2 pt-3">
          {row.kind !== 'approval_request' && (
            <Button
              data-testid="detail-accept"
              disabled={props.busy || !canAccept(row)}
              onClick={props.onAccept}
            >
              {row.kind === 'sync_conflict'
                ? t('sync.conflict.keepMine')
                : t(info?.informational ? 'inbox.actions.acknowledge' : 'inbox.actions.accept')}
            </Button>
          )}
          {editableFields(row.kind).length > 0 && (
            <Button variant="secondary" data-testid="detail-edit" onClick={props.onEdit}>
              {t('inbox.actions.edit')}
            </Button>
          )}
          {row.kind !== 'approval_request' && (
            <Button variant="ghost" data-testid="detail-reject" onClick={props.onReject}>
              {row.kind === 'sync_conflict'
                ? t('sync.conflict.keepTheirs')
                : t('inbox.actions.reject')}
            </Button>
          )}
          <DropdownMenu open={props.snoozeOpen} onOpenChange={props.onSnoozeOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" data-testid="detail-snooze">
                {t('inbox.actions.snooze')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {SNOOZE_PRESETS.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  data-testid={`snooze-${p.id}`}
                  onSelect={() => props.onSnooze(p.ms)}
                >
                  {t(`inbox.snooze.${p.id}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {openTarget(row) && (
            <Button variant="ghost" data-testid="detail-open" onClick={props.onOpen}>
              {t('inbox.actions.open')}
            </Button>
          )}
        </div>
      )}
      {view === 'snoozed' && (
        <div className="pt-3">
          {row.snoozedUntil && (
            <p className="pb-2 text-xs text-fg-muted">
              {t('inbox.until', { date: new Date(row.snoozedUntil).toLocaleDateString('en-IN') })}
            </p>
          )}
          <Button variant="secondary" onClick={props.onUnsnooze}>
            {t('inbox.actions.unsnooze')}
          </Button>
        </div>
      )}
      {view === 'done' && (
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <StatusLine row={row} />
          {openTarget(row) && (
            <Button variant="ghost" data-testid="detail-open" onClick={props.onOpen}>
              {t('inbox.actions.open')}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function RejectDialog(props: {
  row: InboxRow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <AlertDialog open onOpenChange={(o) => !o && props.onCancel()}>
      <AlertDialogContent data-testid="reject-dialog">
        <AlertDialogTitle>{t('inbox.reject.title')}</AlertDialogTitle>
        <AlertDialogDescription>{t('inbox.reject.body')}</AlertDialogDescription>
        <Textarea
          ref={focusOnMount}
          value={reason}
          placeholder={t('inbox.reject.reason')}
          aria-label={t('inbox.reject.reason')}
          data-testid="reject-reason"
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) props.onConfirm(reason);
          }}
        />
        <div className="flex justify-end gap-2 pt-3">
          <Button variant="ghost" onClick={props.onCancel}>
            {t('confirm.cancel')}
          </Button>
          <Button
            data-testid="reject-confirm"
            disabled={props.busy}
            onClick={() => props.onConfirm(reason)}
          >
            {t('inbox.reject.confirm')}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EditDialog(props: {
  row: InboxRow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (value: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const term = useTerm();
  const { row } = props;
  const s = row.suggestion;
  const fields = editableFields(row.kind);
  const [code, setCode] = useState(String(s['code'] ?? ''));
  const [message, setMessage] = useState(String(s['message'] ?? ''));
  const [swap, setSwap] = useState(false);
  const submit = () => {
    const value: Record<string, unknown> = { ...s };
    if (fields.includes('code')) value['code'] = code.trim();
    if (fields.includes('message')) value['message'] = message;
    if (fields.includes('keep') && swap) {
      value['keepId'] = s['mergeId'];
      value['keepName'] = s['mergeName'];
      value['mergeId'] = s['keepId'];
      value['mergeName'] = s['keepName'];
    }
    props.onConfirm(value);
  };
  return (
    <AlertDialog open onOpenChange={(o) => !o && props.onCancel()}>
      <AlertDialogContent data-testid="edit-dialog">
        <AlertDialogTitle>{t('inbox.edit.title')}</AlertDialogTitle>
        <AlertDialogDescription>{headline(row)}</AlertDialogDescription>
        {fields.includes('code') && (
          <label className="block text-sm" htmlFor="edit-code">
            {term('hsn')}
            <Input
              id="edit-code"
              ref={focusOnMount}
              value={code}
              data-testid="edit-code"
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
        )}
        {fields.includes('message') && (
          <label className="block text-sm" htmlFor="edit-message">
            {t('inbox.messageLabel')}
            <Textarea
              id="edit-message"
              ref={focusOnMount}
              rows={6}
              value={message}
              data-testid="edit-message"
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
        )}
        {fields.includes('keep') && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={swap}
              data-testid="edit-swap"
              onCheckedChange={(c) => setSwap(c === true)}
            />
            {swap
              ? t('inbox.describe.duplicate_party', { keep: s['mergeName'], merge: s['keepName'] })
              : t('inbox.describe.duplicate_party', { keep: s['keepName'], merge: s['mergeName'] })}
          </label>
        )}
        <div className="flex justify-end gap-2 pt-3">
          <Button variant="ghost" onClick={props.onCancel}>
            {t('confirm.cancel')}
          </Button>
          <Button data-testid="edit-confirm" disabled={props.busy} onClick={submit}>
            {t('inbox.edit.apply')}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const MAX_PREVIEW = 200;

function BulkDialog({ rows, onClose }: { rows: InboxRow[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [min, setMin] = useState(BULK_MIN_CONFIDENCE);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const sure = rows.filter((r) => (r.confidence ?? 0) >= min);
  const chosen = sure.filter((r) => !off.has(r.id));

  const go = async () => {
    if (!database || !ctx || chosen.length === 0) return;
    setBusy(true);
    try {
      await acceptReviewItems(
        database,
        ctx,
        chosen.map((r) => r.row),
      );
      toast.success(t('inbox.toast.bulk', { count: chosen.length }));
      onClose();
    } catch (e) {
      toast.error(t('inbox.toast.failed', { message: errText(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent data-testid="bulk-dialog" className="max-w-2xl">
        <AlertDialogTitle>{t('inbox.bulk.title')}</AlertDialogTitle>
        <AlertDialogDescription>{t('inbox.bulk.body')}</AlertDialogDescription>
        <div className="flex items-center gap-2 py-2 text-sm">
          <span>{t('inbox.bulk.confidence')}</span>
          <Select value={String(min)} onValueChange={(v) => setMin(Number(v))}>
            <SelectTrigger
              className="w-24"
              aria-label={t('inbox.bulk.confidence')}
              data-testid="bulk-min"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[95, 90, 80, 70, 50].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {sure.length === 0 ? (
          <p className="py-4 text-sm text-fg-muted">{t('inbox.bulk.none')}</p>
        ) : (
          <ul
            className="max-h-72 overflow-auto rounded-md border border-border"
            data-testid="bulk-preview"
          >
            {sure.slice(0, MAX_PREVIEW).map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-sm"
                data-testid="bulk-row"
              >
                <Checkbox
                  checked={!off.has(r.id)}
                  aria-label={headline(r)}
                  onCheckedChange={(c) => {
                    const next = new Set(off);
                    if (c === true) next.delete(r.id);
                    else next.add(r.id);
                    setOff(next);
                  }}
                />
                <span className="min-w-0 flex-1 truncate">{summary(r, t)}</span>
                <span className="text-xs tabular-nums text-fg-muted">{r.confidence}%</span>
              </li>
            ))}
          </ul>
        )}
        <p className="pt-2 text-xs text-fg-muted">{t('inbox.bulk.all')}</p>
        <div className="flex justify-end gap-2 pt-3">
          <Button variant="ghost" onClick={onClose}>
            {t('confirm.cancel')}
          </Button>
          <Button
            data-testid="bulk-confirm"
            disabled={busy || chosen.length === 0}
            onClick={() => void go()}
          >
            {t('inbox.bulk.confirm', { count: chosen.length })}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

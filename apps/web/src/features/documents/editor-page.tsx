import { DocumentFlowRepo, PartyRepo, SettingsRepo, type Row } from '@gst/db';
import {
  CONVERSIONS,
  convertDraft,
  draftToRows,
  duplicateDraft,
  isBlankLine,
  isBlankDraft,
  type DocumentType,
  type DraftIssue,
  type LineSelection,
} from '@gst/domain';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PageHeader,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  formatPaise,
} from '@gst/ui';
import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adoptedIds } from './adopt';
import { ConvertDialog } from './convert-dialog';
import { EditorFooter } from './editor-footer';
import { EditorHeader } from './editor-header';
import { ItemPicker } from './item-picker';
import { LineGrid, type LineGridHandle } from './line-grid';
import { DocumentPreview } from './preview';
import { AttachmentPane, PurchaseFields } from './purchase-extras';
import {
  DEFAULT_HIDDEN,
  GRID_COLUMNS,
  applyItem,
  isPurchase,
  newLineKey,
  qtyText,
  updateLine,
  type GridColumn,
} from './state';
import { TraceView, type TraceTarget } from './trace-view';
import { useDocumentEditor } from './use-editor';

import { useRightPanel } from '@/app/components/panel';
import { useAppDb, useLiveQuery } from '@/app/db';
import type { Shell } from '@/app/store';
import { useUnits } from '@/features/items/hooks';
import { ItemEditor } from '@/features/items/item-editor';

const todayIso = () => new Date().toISOString().slice(0, 10);

export const editorPath = (shell: Shell) =>
  shell === 'shop' ? '/shop/sell' : '/books/documents/new';

/** Shop keeps it to what a counter needs. */
const SHOP_HIDDEN: readonly GridColumn[] = [
  'hsn',
  'unit',
  'incl',
  'discount',
  'taxRate',
  'tax',
  'note',
];
const COLUMNS_KEY = 'documents.hidden_columns';

type Side = 'preview' | 'attachment';

/**
 * The document editor: header, line grid, footer, a live preview and the calculation trace. The same
 * component serves both shells; Shop shows only party, lines, totals and print.
 */
export function EditorPage({
  shell,
  type,
  id,
}: {
  shell: Shell;
  type: DocumentType;
  id: string | null;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { database, ctx, business } = useAppDb();
  const unitRows = useUnits().data;
  const units = useMemo(() => unitRows ?? [], [unitRows]);
  const editor = useDocumentEditor({ type, id });
  const { draft, built, meta, readOnly } = editor;
  const simple = shell === 'shop';
  const purchase = isPurchase(draft.type);
  const businessState: string = business?.['state_code'] ?? '';

  const grid = useRef<LineGridHandle>(null);
  const [side, setSide] = useState<Side>('preview');
  const [trace, setTrace] = useState<TraceTarget | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [picker, setPicker] = useState<{ row: number; typed?: string } | null>(null);
  const [creating, setCreating] = useState<{ name: string; key: string } | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [convertTo, setConvertTo] = useState<DocumentType | null>(null);
  const [busy, setBusy] = useState(false);
  const { setContent: setPanel } = useRightPanel();
  const [hidden, setHidden] = useState<ReadonlySet<GridColumn>>(new Set(DEFAULT_HIDDEN));

  const unitCodes = useMemo(
    () => new Map(units.map((u) => [u['id'] as string, u['code'] as string])),
    [units],
  );

  // the business's column choices
  useEffect(() => {
    if (!database || !ctx || simple) return;
    void new SettingsRepo(database).getValue<GridColumn[]>(ctx, COLUMNS_KEY).then((v) => {
      if (Array.isArray(v)) setHidden(new Set(v.filter((c) => GRID_COLUMNS.includes(c))));
    });
  }, [database, ctx, simple]);
  const hiddenNow = simple ? new Set(SHOP_HIDDEN) : hidden;
  const toggleColumn = (col: GridColumn) => {
    const next = new Set(hidden);
    if (next.has(col)) next.delete(col);
    else next.add(col);
    setHidden(next);
    if (database && ctx) void new SettingsRepo(database).set(ctx, COLUMNS_KEY, [...next]);
  };

  // Books shows the explanation in the shell's right panel and keeps it current as the numbers change
  useEffect(() => {
    if (shell !== 'books' || !trace) return;
    setPanel(<TraceView built={built} draft={draft} target={trace} />);
  }, [shell, trace, built, draft, setPanel]);
  useEffect(() => () => setPanel(null), [setPanel]);

  // once a draft has an id, put it in the address so a reload comes back to it
  const lastUrlId = useRef(id);
  useEffect(() => {
    if (!meta.id || meta.id === lastUrlId.current) return;
    lastUrlId.current = meta.id;
    adoptedIds.add(meta.id);
    void router.navigate({
      to: editorPath(shell) as never,
      search: { type: draft.type, id: meta.id } as never,
      replace: true,
    });
  }, [meta.id, router, shell, draft.type]);

  /* ---------------------------------------------------------------- items */

  const lineKeyAt = (row: number) => draft.lines[row]?.key;
  const chooseItem = (item: Row, qtyMicros?: bigint) => {
    const row = picker?.row ?? 0;
    const key = lineKeyAt(row);
    setPicker(null);
    setCreating(null);
    if (!key) return;
    editor.setDraft((d) =>
      updateLine(d, key, (l) => ({
        ...applyItem(l, item, d.type),
        ...(qtyMicros !== undefined ? { qtyMicros } : {}),
      })),
    );
    // on to the next line's item, ready for its Enter
    requestAnimationFrame(() => grid.current?.select('item', row + 1));
  };

  /** A typed name that is not one of the items: offer to create it. */
  const unlinked = draft.lines.find(
    (l) =>
      !isBlankLine(l) && l.itemId === null && l.description.trim() !== '' && !dismissed.has(l.key),
  );

  /* ---------------------------------------------------------------- actions */

  const problemsText = (issues: DraftIssue[]) =>
    issues.map((i) => t(`docs.issue.${i.code}`, { line: (i.line ?? 0) + 1, defaultValue: i.code }));

  const doIssue = async (after?: 'print' | 'share') => {
    setBusy(true);
    try {
      const { issues, number } = await editor.issue();
      if (issues.length > 0 || !number) {
        setShowIssues(true);
        toast.error(problemsText(issues)[0] ?? t('docs.issue.issue_failed'));
        const first = issues.find((i) => i.line !== undefined);
        if (first) grid.current?.select('item', first.line!);
        return;
      }
      setShowIssues(false);
      toast.success(t('docs.issued', { number }));
      if (after === 'print') setTimeout(() => window.print(), 300);
      if (after === 'share') await share(number);
    } finally {
      setBusy(false);
    }
  };

  /** A WhatsApp message with the number and total. The PDF itself comes with the template designer. */
  const share = async (number: string) => {
    let phone = '';
    if (database && ctx && draft.partyId) {
      const p = await new PartyRepo(database).get(ctx, draft.partyId);
      phone = String(p?.['phone'] ?? '').replace(/\D/g, '');
    }
    const text = t('docs.shareText', {
      party: draft.partyName || '',
      type: t(`docs.types.${draft.type}`),
      number,
      total: formatPaise(built.totals.totalPaise),
      business: business?.['trade_name'] ?? business?.['legal_name'] ?? '',
    });
    window.open(
      `https://wa.me/${phone ? `91${phone.slice(-10)}` : ''}?text=${encodeURIComponent(text)}`,
      '_blank',
      'noopener',
    );
  };

  const saveNow = async () => {
    const ok = await editor.save();
    if (ok) toast.success(t('docs.save.saved'));
  };

  /** Save a new draft derived from this one, then open it. */
  const spawn = async (next: ReturnType<typeof duplicateDraft>, sourceId: string | null) => {
    if (!database || !ctx) return;
    setBusy(true);
    try {
      const rows = draftToRows(next);
      const saved = await new DocumentFlowRepo(database).saveDraft(ctx, {
        doc: rows.doc as never,
        lines: rows.lines as never,
        sourceDocumentId: sourceId,
      });
      await router.navigate({
        to: editorPath(shell) as never,
        search: { type: next.type, id: saved.document['id'] } as never,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConvertTo(null);
    }
  };

  const convert = (selection: LineSelection[] | undefined) => {
    if (!convertTo) return;
    try {
      void spawn(convertDraft(draft, convertTo, todayIso(), newLineKey, selection), meta.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  const targets = (CONVERSIONS[draft.type] ?? []).filter(
    (x) => meta.id && (meta.status === 'issued' || !['credit_note', 'debit_note'].includes(x)),
  );

  // Ctrl+S saves, Ctrl+Enter issues, wherever the focus is (the grid is a canvas)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 's') {
        e.preventDefault();
        void saveNow();
      } else if (e.key === 'Enter' && !readOnly) {
        e.preventDefault();
        void doIssue();
      }
    };
    // capture phase: the grid's canvas stops key events from bubbling up to the window
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const ensureSaved = useCallback(async (): Promise<string | null> => {
    const ok = await editor.save();
    return ok ? editor.currentId() : null;
  }, [editor]);

  const saveLabel = {
    idle: '',
    dirty: t('docs.save.dirty'),
    saving: t('docs.save.saving'),
    saved: t('docs.save.savedShort'),
    error: t('docs.save.error'),
    conflict: t('docs.save.conflict'),
  }[editor.saveState];

  if (editor.notFound)
    return (
      <p className="p-4" data-testid="doc-not-found">
        {t('docs.notFound')}
      </p>
    );
  if (editor.loading) return <p className="p-4 text-fg-muted">{t('empty.loading')}</p>;

  const numberLabel = meta.number ?? t('docs.header.numberAuto');
  const attachmentTab = purchase && !simple;
  const issueProblems = showIssues ? problemsText(editor.issues) : [];

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="doc-editor"
      data-shell={shell}
      data-status={meta.status}
    >
      <PageHeader
        title={t(`docs.types.${draft.type}`)}
        description={
          readOnly
            ? t('docs.readOnly', { status: t(`docs.status.${meta.status}`) })
            : t('docs.draftHelp')
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {meta.number && <Badge data-testid="doc-issued-number">{meta.number}</Badge>}
            <Badge data-testid="doc-status">{t(`docs.status.${meta.status}`)}</Badge>
            <span
              className="text-xs text-fg-muted"
              aria-live="polite"
              data-testid="save-state"
              data-state={editor.saveState}
            >
              {saveLabel}
            </span>
            {!readOnly && (
              <>
                <Button variant="outline" data-testid="doc-save" onClick={() => void saveNow()}>
                  {t('docs.actions.save')}
                </Button>
                <Button
                  data-testid="doc-issue"
                  disabled={busy}
                  onClick={() => void doIssue(simple ? 'print' : undefined)}
                >
                  {simple ? t('docs.actions.issuePrint') : t('docs.actions.issue')}
                </Button>
              </>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" data-testid="doc-more">
                  {t('docs.actions.more')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!readOnly && !simple && (
                  <>
                    <DropdownMenuItem
                      data-testid="doc-issue-print"
                      onSelect={() => void doIssue('print')}
                    >
                      {t('docs.actions.issuePrint')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="doc-issue-share"
                      onSelect={() => void doIssue('share')}
                    >
                      {t('docs.actions.issueShare')}
                    </DropdownMenuItem>
                  </>
                )}
                {readOnly && (
                  <DropdownMenuItem data-testid="doc-print" onSelect={() => window.print()}>
                    {t('docs.actions.print')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  data-testid="doc-duplicate"
                  disabled={!meta.id}
                  onSelect={() => void spawn(duplicateDraft(draft, todayIso(), newLineKey), null)}
                >
                  {t('docs.actions.duplicate')}
                </DropdownMenuItem>
                {targets.map((target) => (
                  <DropdownMenuItem
                    key={target}
                    data-testid={`doc-convert-${target}`}
                    onSelect={() => setConvertTo(target)}
                  >
                    {t('docs.actions.convert', { to: t(`docs.types.${target}`) })}
                  </DropdownMenuItem>
                ))}
                {!readOnly && meta.id && (
                  <DropdownMenuItem
                    data-testid="doc-discard"
                    onSelect={() =>
                      void editor.discard().then(() =>
                        router.navigate({
                          to: (shell === 'shop' ? '/shop/documents' : '/books/documents') as never,
                        }),
                      )
                    }
                  >
                    {t('docs.actions.discard')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      {!meta.id && isBlankDraft(draft) && (
        <ResumeBanner
          type={draft.type}
          onResume={(docId) =>
            router.navigate({
              to: editorPath(shell) as never,
              search: { type: draft.type, id: docId } as never,
            })
          }
        />
      )}

      {issueProblems.length > 0 && (
        <ul
          role="alert"
          className="rounded-md border border-danger p-3 text-sm text-danger"
          data-testid="doc-problems"
        >
          {issueProblems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {editor.saveError && editor.saveState !== 'saved' && (
        <p
          role="alert"
          className="rounded-md border border-danger p-2 text-sm text-danger"
          data-testid="save-error"
        >
          {editor.saveError}
        </p>
      )}

      <div
        className={
          simple ? 'flex flex-col gap-4' : 'grid gap-4 2xl:grid-cols-[minmax(0,1fr)_30rem]'
        }
      >
        <div className="flex min-w-0 flex-col gap-4">
          <EditorHeader
            draft={draft}
            issues={editor.issues}
            showIssues={showIssues}
            readOnly={readOnly}
            businessState={businessState}
            numberLabel={numberLabel}
            simple={simple}
            onPartyPicked={() =>
              requestAnimationFrame(() =>
                grid.current?.select('item', Math.max(0, draft.lines.findIndex(isBlankLine))),
              )
            }
            onChange={editor.setDraft}
          />
          {purchase && !simple && (
            <PurchaseFields
              draft={draft}
              readOnly={readOnly}
              showIssues={showIssues}
              onChange={editor.setDraft}
            />
          )}

          <LineGrid
            ref={grid}
            draft={draft}
            built={built}
            issues={showIssues ? editor.issues : []}
            units={units}
            hidden={hiddenNow}
            readOnly={readOnly}
            onChange={editor.setDraft}
            // a picker that is already open keeps the keyboard; letters still reaching the grid are ignored
            onPickItem={(row, typed) =>
              setPicker((open) => open ?? { row, ...(typed ? { typed } : {}) })
            }
            onTrace={(key) => setTrace({ kind: 'line', key })}
            onToggleColumn={toggleColumn}
          />

          {unlinked && !readOnly && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm"
              data-testid="item-offer"
            >
              <span className="flex-1">
                {t('docs.items.offer', { name: unlinked.description })}
              </span>
              <Button
                variant="outline"
                data-testid="item-offer-create"
                onClick={() => setCreating({ name: unlinked.description, key: unlinked.key })}
              >
                {t('docs.items.createShort')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setDismissed(new Set([...dismissed, unlinked.key]))}
              >
                {t('docs.items.keepText')}
              </Button>
            </div>
          )}

          <EditorFooter
            draft={draft}
            built={built}
            readOnly={readOnly}
            documentId={meta.id}
            simple={simple}
            onChange={editor.setDraft}
            onTrace={() => setTrace({ kind: 'document' })}
          />
        </div>

        {simple ? (
          <div aria-hidden className="pointer-events-none fixed left-[-10000px] top-0">
            <DocumentPreview
              draft={draft}
              built={built}
              business={business}
              units={unitCodes}
              number={meta.number}
            />
          </div>
        ) : (
          <aside
            className="min-w-0 2xl:sticky 2xl:top-2 2xl:max-h-[calc(100vh-1rem)]"
            aria-label={t('docs.side.title')}
          >
            <Tabs
              value={side}
              onValueChange={(v) => setSide(v as Side)}
              className="flex h-full flex-col gap-2"
            >
              <TabsList>
                <TabsTrigger value="preview" data-testid="tab-preview">
                  {t('docs.side.preview')}
                </TabsTrigger>
                {attachmentTab && (
                  <TabsTrigger value="attachment" data-testid="tab-attachment">
                    {t('docs.side.attachment')}
                  </TabsTrigger>
                )}
              </TabsList>
              <TabsContent value="preview" className="min-h-0 flex-1">
                <DocumentPreview
                  draft={draft}
                  built={built}
                  business={business}
                  units={unitCodes}
                  number={meta.number}
                />
              </TabsContent>
              {attachmentTab && (
                <TabsContent value="attachment" className="min-h-0 flex-1">
                  <AttachmentPane
                    documentId={meta.id}
                    readOnly={readOnly}
                    ensureSaved={ensureSaved}
                  />
                </TabsContent>
              )}
            </Tabs>
          </aside>
        )}
      </div>

      {picker && (
        <ItemPicker
          initialQty={qtyText(draft.lines[picker.row]?.qtyMicros ?? 1_000_000n)}
          initialQuery={
            picker.typed ??
            (draft.lines[picker.row]?.itemId ? '' : (draft.lines[picker.row]?.description ?? ''))
          }
          price={purchase ? 'purchase' : 'sale'}
          onPick={chooseItem}
          onText={(text) => {
            const row = picker.row;
            const key = lineKeyAt(row);
            setPicker(null);
            if (!key) return;
            editor.setDraft((d) =>
              updateLine(d, key, (l) => ({ ...l, description: text, itemId: null })),
            );
            requestAnimationFrame(() => grid.current?.select('item', row + 1));
          }}
          onCreate={(name) => {
            const key = lineKeyAt(picker.row);
            setPicker(null);
            if (key) setCreating({ name, key });
          }}
          onClose={() => {
            const row = picker.row;
            setPicker(null);
            requestAnimationFrame(() => grid.current?.select('item', row));
          }}
        />
      )}
      {creating && (
        <Sheet open onOpenChange={(o) => !o && setCreating(null)}>
          <SheetContent className="w-[min(42rem,100vw)] overflow-auto" data-testid="item-quick">
            <SheetTitle className="text-lg font-semibold">{t('items.form.titleNew')}</SheetTitle>
            <SheetDescription className="pb-3 text-fg-muted">
              {t('docs.items.quickHelp')}
            </SheetDescription>
            <ItemEditor
              prefill={{ name: creating.name }}
              onCancel={() => setCreating(null)}
              onDone={(item) => {
                const key = creating.key;
                const row = draft.lines.findIndex((l) => l.key === key);
                setCreating(null);
                editor.setDraft((d) => updateLine(d, key, (l) => applyItem(l, item, d.type)));
                if (row >= 0) requestAnimationFrame(() => grid.current?.select('item', row + 1));
              }}
            />
          </SheetContent>
        </Sheet>
      )}
      {shell === 'shop' && trace && (
        <Sheet open onOpenChange={(o) => !o && setTrace(null)}>
          <SheetContent className="w-[min(28rem,100vw)] overflow-auto" data-testid="trace-sheet">
            <SheetTitle className="sr-only">{t('docs.trace.title')}</SheetTitle>
            <SheetDescription className="sr-only">{t('docs.trace.empty')}</SheetDescription>
            <TraceView built={built} draft={draft} target={trace} />
          </SheetContent>
        </Sheet>
      )}
      {convertTo && (
        <ConvertDialog
          draft={draft}
          target={convertTo}
          busy={busy}
          onConfirm={convert}
          onClose={() => setConvertTo(null)}
        />
      )}
    </div>
  );
}

/**
 * A new, empty document with an earlier unfinished draft of the same type: offer to carry on with it.
 * Drafts are saved as you type, so a closed tab or a crash loses nothing.
 */
function ResumeBanner({ type, onResume }: { type: DocumentType; onResume: (id: string) => void }) {
  const { t } = useTranslation();
  const { data } = useLiveQuery<Row[]>({
    tables: ['documents'],
    key: ['resume', type],
    fn: async (d, c) => {
      const recently = Date.now() - 3 * 24 * 3600 * 1000;
      return (await new DocumentFlowRepo(d).listDrafts(c, 10)).filter(
        (r) => r['type'] === type && Number(r['updated_at']) > recently,
      );
    },
  });
  const recent = data?.[0];
  if (!recent) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm"
      data-testid="resume-banner"
    >
      <span className="flex-1">
        {t('docs.resume.text', {
          party: recent['party_name'] || t('docs.preview.cash'),
          total: formatPaise(BigInt(Number(recent['total_paise']))),
        })}
      </span>
      <Button variant="outline" data-testid="resume-draft" onClick={() => onResume(recent['id'])}>
        {t('docs.resume.resume')}
      </Button>
    </div>
  );
}

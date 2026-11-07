import { DocumentFlowRepo, NumberingRepo, SettingsRepo, type Row, type SeriesView } from '@gst/db';
import {
  CONVERSIONS,
  can,
  convertDraft,
  documentModule,
  needsApproval,
  draftToRows,
  duplicateDraft,
  isBlankLine,
  isBlankDraft,
  isProvisional,
  type DocumentType,
  type DraftIssue,
  type LineSelection,
} from '@gst/domain';
import { printLabel } from '@gst/i18n';
import { SCRIPT_FAMILY } from '@gst/print';
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
import { CancelDialog } from './cancel-dialog';
import { ConvertDialog } from './convert-dialog';
import { EditorFooter } from './editor-footer';
import { EditorHeader } from './editor-header';
import { HistoryTab } from './history-tab';
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

import { getBlob } from '@/app/blobs';
import { useConfirm } from '@/app/components/confirm';
import { useRightPanel } from '@/app/components/panel';
import { useAppDb, useLiveQuery } from '@/app/db';
import type { Shell } from '@/app/store';
import { useFeatureFlags } from '@/features/business/hooks';
import type { MessageKind } from '@/features/cloud/client';
import { CollectItems, CollectOverlay, useLivePayLink } from '@/features/collect/collect-dialog';
import {
  DocumentMessageItems,
  DocumentMessages,
  RepeatOverlay,
} from '@/features/dispatch/document-messages';
import { useDocPortal } from '@/features/einvoice/hooks';
import { EinvoicePanel } from '@/features/einvoice/panel';
import { useGodowns, useStockLabels, useStockText } from '@/features/inventory/hooks';
import { StockDetailsDialog } from '@/features/inventory/stock-details';
import { useUnits } from '@/features/items/hooks';
import { ItemEditor } from '@/features/items/item-editor';
import { useLockOverride } from '@/features/numbering/lock-override';
import { useParty } from '@/features/parties/hooks';
import { ApplyCreditBanner } from '@/features/payments/apply-credit-banner';
import { CustomerLinkItem, CustomerLinkOverlay } from '@/features/portal/customer-link';
import {
  downloadBytes,
  emailLink,
  findSavedPdf,
  pdfFileName,
  savePdfAttachment,
  shareDocument,
} from '@/features/print/actions';
import { familiesFor, loadFonts } from '@/features/print/fonts-client';
import { makePdf, stampCancelled } from '@/features/print/pdf-client';
import { modelNow, usePrintContext, usePrintModel } from '@/features/print/use-print-model';
import {
  specOf,
  useDefaultTemplateId,
  useTemplates,
  withPartyLanguage,
} from '@/features/print/use-templates';
import { usePermissions } from '@/features/team/permissions';
import { track } from '@/features/telemetry/telemetry';

const MESSAGE_KIND: Partial<Record<string, MessageKind>> = {
  tax_invoice: 'invoice',
  bill_of_supply: 'invoice',
  debit_note: 'invoice',
};
const todayIso = () => new Date().toISOString().slice(0, 10);

/** Documents money settles, so credit can be applied to them. */
const PAYABLE_TYPES: readonly string[] = [
  'tax_invoice',
  'bill_of_supply',
  'debit_note',
  'purchase_bill',
  'expense',
];

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
/**
 * Constants, not values made during a render: the grid redraws its canvas when a prop changes, and a
 * new empty array or a new set on every keystroke made it redraw on every keystroke.
 */
const SHOP_HIDDEN_SET: ReadonlySet<GridColumn> = new Set(SHOP_HIDDEN);
const NO_ISSUES: DraftIssue[] = [];
/** Without inventory there is nothing to choose for a line, so the stock column stays out of the way. */
const withoutStock = (hidden: ReadonlySet<GridColumn>): ReadonlySet<GridColumn> =>
  hidden.has('stock') ? hidden : new Set([...hidden, 'stock']);

type Side = 'preview' | 'attachment' | 'history' | 'einvoice';

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
  const editor = useDocumentEditor({ type, id, shell });
  const { draft, built, meta, readOnly } = editor;
  const isDraft = meta.status === 'draft';
  // what this person may do with this kind of document (prompt 42); the server checks it again
  const { perms, policy } = usePermissions();
  const docModule = documentModule(draft.type);
  const mayIssue = can(perms, docModule, 'issue');
  const mayEdit = can(perms, docModule, 'edit') || (!meta.id && can(perms, docModule, 'create'));
  const mayCancel = can(perms, docModule, 'cancel');
  const denied = t('team.denied');
  const heldNote = (change: 'cancel' | 'revise') =>
    needsApproval(perms, policy, docModule, change) ? t('docs.approval.held') : undefined;
  const { ask: askOverride, dialog: overrideDialog } = useLockOverride();
  const confirm = useConfirm();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [creditFor, setCreditFor] = useState<{ id: string; number: string; party: string } | null>(
    null,
  );
  const seriesQuery = useLiveQuery<SeriesView[]>({
    tables: ['number_series'],
    key: ['series', draft.type],
    fn: (d, c) => new NumberingRepo(d).listSeries(c, draft.type),
  });
  const simple = shell === 'shop';
  const purchase = isPurchase(draft.type);
  const businessState: string = business?.['state_code'] ?? '';

  const grid = useRef<LineGridHandle>(null);
  const [side, setSide] = useState<Side>('preview');
  const [trace, setTrace] = useState<TraceTarget | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [picker, setPicker] = useState<{ row: number; typed?: string } | null>(null);
  const [stockRow, setStockRow] = useState<number | null>(null);
  const [creating, setCreating] = useState<{ name: string; key: string } | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [convertTo, setConvertTo] = useState<DocumentType | null>(null);
  /** The dialogs of the More menu's cloud items; they sit outside the menu, which unmounts when it closes. */
  const [overlay, setOverlay] = useState<'link' | 'qr' | 'repeat' | 'customer' | null>(null);
  const [busy, setBusy] = useState(false);
  const { setContent: setPanel } = useRightPanel();
  const [hidden, setHidden] = useState<ReadonlySet<GridColumn>>(new Set(DEFAULT_HIDDEN));

  // what prints: the template for this document type (Books and Shop can differ), or the one picked here
  const templates = useTemplates();
  const defaultTemplate = useDefaultTemplateId(draft.type, shell);
  const [pickedTemplate, setPickedTemplate] = useState<string | null>(null);
  const templateId = pickedTemplate ?? defaultTemplate;
  const baseSpec = specOf(templates.options, templateId);
  const partyQuery = useParty(draft.partyId);
  const printContext = usePrintContext();
  const portal = useDocPortal(meta.id);
  const einv = portal?.einv && portal.einv['status'] === 'active' ? portal.einv : null;
  const portalPrint = {
    einvoice: einv
      ? {
          irn: String(einv['irn']),
          ackNo: String(einv['ack_no'] ?? ''),
          ackDate: String(einv['ack_date'] ?? ''),
          signedQr: einv['signed_qr'] ? String(einv['signed_qr']) : null,
        }
      : null,
    eway: portal?.ewbs.find((w) => w['status'] !== 'cancelled')?.['ewb_no'] ?? null,
  };
  // the queue records an IRN or its cancellation outside the editor: read the document again
  const einvKey = `${String(einv?.['id'] ?? '')}:${String(portal?.einv?.['status'] ?? '')}`;
  const lastEinvKey = useRef(einvKey);
  useEffect(() => {
    if (lastEinvKey.current === einvKey) return;
    lastEinvKey.current = einvKey;
    if (!editor.revising) editor.refresh();
  }, [einvKey, editor]);
  const model = usePrintModel({
    draft,
    built,
    number: meta.number,
    status: meta.status,
    revision: meta.revision,
    party: partyQuery.data ?? null,
    ...portalPrint,
  });
  // a party with a language of their own gets their copy in it
  const spec = withPartyLanguage(baseSpec, model?.party);

  // the business's column choices
  useEffect(() => {
    if (!database || !ctx || simple) return;
    void new SettingsRepo(database).getValue<GridColumn[]>(ctx, COLUMNS_KEY).then((v) => {
      if (Array.isArray(v)) setHidden(new Set(v.filter((c) => GRID_COLUMNS.includes(c))));
    });
  }, [database, ctx, simple]);
  const flags = useFeatureFlags();
  const hiddenWithStock = useMemo(
    () => (flags.inventory ? hidden : withoutStock(hidden)),
    [flags.inventory, hidden],
  );
  const hiddenNow = simple ? SHOP_HIDDEN_SET : hiddenWithStock;
  const stockLabels = useStockLabels(draft);
  const godownList = useGodowns().data;
  const defaultGodownId = useMemo(
    () => godownList?.find((g) => g.isDefault)?.id ?? null,
    [godownList],
  );
  const stockText = useStockText(flags.inventory ? stockLabels.data : undefined, defaultGodownId);
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
    // stay on the route we are on (Sell and New document are different routes; going from one to the
    // other would remount the editor and lose whatever it was in the middle of)
    void router.navigate({
      to: router.state.location.pathname as never,
      search: { type: draft.type, id: meta.id } as never,
      replace: true,
    });
  }, [meta.id, router, draft.type]);

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
      let result = await editor.issue();
      let stockOk = false;
      if (result.stock) {
        const list = result.stock.shortfalls
          .map((s) =>
            t('docs.stock.line', {
              name: s.name,
              have: qtyText(BigInt(s.onHandMicros)),
              need: qtyText(BigInt(s.needMicros)),
            }),
          )
          .join('\n');
        if (result.stock.action === 'block') {
          toast.error(`${t('docs.stock.blocked')} ${list.replace(/\n/g, '; ')}`);
          return;
        }
        // allowed, but the stock will go below zero: say so and let them decide
        const go = await confirm({
          title: t('docs.stock.warnTitle'),
          description: list,
          confirmLabel: t('docs.stock.issueAnyway'),
        });
        if (!go) return;
        stockOk = true;
        result = await editor.issue(undefined, { stockOk });
      }
      if (result.locked) {
        // a closed period: only an owner with a reason can go on
        const reason = await askOverride(result.locked.until);
        if (!reason) return;
        result = await editor.issue({ reason }, { stockOk });
      }
      const { issues, number } = result;
      if (issues.length > 0 || !number) {
        setShowIssues(true);
        toast.error(problemsText(issues)[0] ?? t('docs.issue.issue_failed'));
        const first = issues.find((i) => i.line !== undefined);
        if (first) grid.current?.select('item', first.line!);
        return;
      }
      setShowIssues(false);
      toast.success(t('docs.issued', { number }));
      track('invoice_issued');
      // a party with an advance or a credit note can have it applied to what was just issued
      const issuedId = editor.currentId();
      if (issuedId && draft.partyId && PAYABLE_TYPES.includes(draft.type))
        setCreditFor({ id: issuedId, number, party: draft.partyName });
      if (after === 'print') setTimeout(() => window.print(), 300);
      if (after === 'share') await share(number);
    } finally {
      setBusy(false);
    }
  };

  /**
   * The PDF of this document as it is right now (a fresh model, so a document that was just issued
   * carries its new number), kept with the document once it has one.
   */
  const payLink = useLivePayLink(
    meta.id ?? null,
    !isDraft && meta.status === 'issued' && !!PAYABLE_TYPES.includes(draft.type),
  );
  const makeCurrentPdf = async (over?: { number: string; status: 'issued' }) => {
    if (!printContext) throw new Error(t('print.notReady'));
    const m = modelNow(printContext, {
      draft,
      built,
      number: over?.number ?? meta.number,
      status: over?.status ?? meta.status,
      revision: meta.revision,
      party: partyQuery.data ?? null,
      ...portalPrint,
      ...(payLink ? { payLink } : {}),
    });
    const fonts = await loadFonts(familiesFor(m, spec));
    const bytes = await makePdf(m, spec, fonts.bytes, {
      title: `${t(`docs.types.${draft.type}`)} ${m.number ?? ''}`.trim(),
      author: m.business.name,
      created: new Date(`${m.date}T00:00:00Z`),
    });
    const fileName = pdfFileName(m, Number(business?.['fy_start_month'] ?? 4));
    const id = editor.currentId();
    if (database && ctx && id && m.number)
      await savePdfAttachment(database, ctx, id, fileName, bytes);
    return { model: m, bytes, fileName };
  };

  const downloadPdf = async () => {
    setBusy(true);
    try {
      const r = await makeCurrentPdf();
      downloadBytes(r.fileName, r.bytes);
      toast.success(t('print.saved', { name: r.fileName }));
      track('pdf_saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Share the PDF: the device's share sheet where it takes files, otherwise WhatsApp with the PDF saved to attach. */
  const share = async (number?: string) => {
    // a provisional number is not a tax invoice number: nothing leaves the device until sync gives a real one
    if (isProvisional(number ?? meta.number)) {
      toast.error(t('sync.provisional.noShare'));
      return;
    }
    try {
      const r = await makeCurrentPdf(number ? { number, status: 'issued' } : undefined);
      const out = await shareDocument({
        model: r.model,
        language: spec.language,
        bytes: r.bytes,
        fileName: r.fileName,
        phone: String(partyQuery.data?.['phone'] ?? ''),
        totalText: formatPaise(built.totals.totalPaise),
      });
      if (out === 'whatsapp') toast.success(t('print.sharedWhatsapp', { name: r.fileName }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const email = async () => {
    try {
      const r = await makeCurrentPdf();
      downloadBytes(r.fileName, r.bytes);
      window.location.href = emailLink(
        r.model,
        spec.language,
        formatPaise(built.totals.totalPaise),
        String(partyQuery.data?.['email'] ?? ''),
      );
      toast.success(t('print.emailed', { name: r.fileName }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  /** Save the changes to an issued document (a new revision when anything financial changed). */
  const doSaveRevision = async () => {
    setBusy(true);
    try {
      let out = await editor.saveRevision();
      if (out.locked) {
        const reason = await askOverride(out.locked.until);
        if (!reason) return;
        out = await editor.saveRevision({ reason });
      }
      if (!out.ok) {
        if (out.error) toast.error(out.error);
        return;
      }
      toast.success(
        out.kind === 'financial'
          ? t('docs.revision.saved')
          : out.kind === 'none'
            ? t('docs.revision.nothing')
            : t('docs.revision.savedNotes'),
      );
      if (out.overAllocatedPaise)
        toast.warning(
          t('docs.revision.overAllocated', { amount: formatPaise(BigInt(out.overAllocatedPaise)) }),
        );
    } finally {
      setBusy(false);
    }
  };

  /** A PDF that was saved before the cancellation gets CANCELLED across every page, replacing the saved file. */
  const stampSavedPdf = async () => {
    const id = editor.currentId();
    if (!database || !ctx || !id) return;
    try {
      const saved = await findSavedPdf(database, ctx, id);
      if (!saved) return;
      const blob = await getBlob(String(saved['storage_path']), 'application/pdf');
      if (!blob) return;
      const script = SCRIPT_FAMILY[spec.language];
      const fonts = await loadFonts(['latin', 'latinExt', ...(script ? [script] : [])]);
      const word = printLabel(spec.language, 'watermark.cancelled');
      const stamped = await stampCancelled(
        new Uint8Array(await blob.arrayBuffer()),
        word,
        fonts.bytes,
      );
      await savePdfAttachment(database, ctx, id, String(saved['file_name']), stamped);
    } catch {
      // the document is cancelled either way; a PDF that could not be stamped is regenerated on the next download
      toast.warning(t('print.stampFailed'));
    }
  };

  const doCancel = async (reason: string) => {
    setBusy(true);
    try {
      let out = await editor.cancel(reason);
      if (out.locked) {
        const why = await askOverride(out.locked.until);
        if (!why) return;
        out = await editor.cancel(reason, { reason: why });
      }
      if (!out.ok) {
        if (out.error) toast.error(out.error);
        return;
      }
      setCancelOpen(false);
      toast.success(t('docs.cancel.done', { number: meta.number ?? '' }));
      void stampSavedPdf();
      if (out.unallocated.length > 0) {
        const sum = out.unallocated.reduce((n, u) => n + BigInt(u.amountPaise), 0n);
        toast.warning(
          t('docs.cancel.unallocated', { count: out.unallocated.length, amount: formatPaise(sum) }),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const saveNow = async () => {
    if (editor.revising) return doSaveRevision();
    if (!isDraft) return;
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
      } else if (e.key === 'Enter' && isDraft) {
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
          editor.revising
            ? t('docs.revising')
            : meta.status === 'cancelled'
              ? t('docs.readOnlyCancelled')
              : readOnly
                ? t('docs.readOnly', { status: t(`docs.status.${meta.status}`) })
                : t('docs.draftHelp')
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {meta.number && <Badge data-testid="doc-issued-number">{meta.number}</Badge>}
            {isProvisional(meta.number) && (
              <Badge
                tone="warning"
                data-testid="doc-provisional"
                title={t('sync.provisional.title')}
              >
                {t('sync.provisional.badge')}
              </Badge>
            )}
            <Badge data-testid="doc-status">{t(`docs.status.${meta.status}`)}</Badge>
            {!isDraft && meta.revision > 1 && (
              <Badge tone="info" data-testid="doc-revision">
                {t('docs.revision.badge', { n: meta.revision })}
              </Badge>
            )}
            <span
              className="text-xs text-fg-muted"
              aria-live="polite"
              data-testid="save-state"
              data-state={editor.saveState}
            >
              {saveLabel}
            </span>
            {meta.status === 'issued' && !editor.revising && (
              <Button
                variant="outline"
                data-testid="doc-edit"
                disabled={meta.hasIrn || !mayEdit}
                title={
                  meta.hasIrn
                    ? t('docs.revision.einvoiced')
                    : !mayEdit
                      ? denied
                      : heldNote('revise')
                }
                onClick={editor.startRevision}
              >
                {t('docs.revision.edit')}
              </Button>
            )}
            {editor.revising && (
              <>
                <Button
                  variant="outline"
                  data-testid="doc-revise-discard"
                  onClick={editor.cancelRevision}
                >
                  {t('docs.revision.discard')}
                </Button>
                <Button
                  data-testid="doc-revise-save"
                  disabled={busy}
                  onClick={() => void doSaveRevision()}
                >
                  {t('docs.revision.save')}
                </Button>
              </>
            )}
            {isDraft && (
              <>
                <Button
                  variant="outline"
                  data-testid="doc-save"
                  disabled={!mayEdit}
                  title={mayEdit ? undefined : denied}
                  onClick={() => void saveNow()}
                >
                  {t('docs.actions.save')}
                </Button>
                <Button
                  data-testid="doc-issue"
                  disabled={busy || !mayIssue}
                  title={mayIssue ? undefined : denied}
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
                {isDraft && !simple && (
                  <>
                    <DropdownMenuItem
                      data-testid="doc-issue-print"
                      disabled={!mayIssue}
                      onSelect={() => void doIssue('print')}
                    >
                      {t('docs.actions.issuePrint')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="doc-issue-share"
                      disabled={!mayIssue}
                      onSelect={() => void doIssue('share')}
                    >
                      {t('docs.actions.issueShare')}
                    </DropdownMenuItem>
                  </>
                )}
                {!isDraft && (
                  <DropdownMenuItem data-testid="doc-print" onSelect={() => window.print()}>
                    {t('docs.actions.print')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem data-testid="doc-pdf" onSelect={() => void downloadPdf()}>
                  {t('print.download')}
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="doc-share" onSelect={() => void share()}>
                  {t('print.share')}
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="doc-email" onSelect={() => void email()}>
                  {t('print.email')}
                </DropdownMenuItem>
                {meta.id && meta.status === 'issued' && PAYABLE_TYPES.includes(draft.type) && (
                  <CollectItems onOpen={setOverlay} />
                )}
                {meta.id && !isDraft && <CustomerLinkItem onOpen={() => setOverlay('customer')} />}
                {meta.id && !isDraft && MESSAGE_KIND[draft.type] && (
                  <DocumentMessageItems
                    documentId={meta.id}
                    kind={MESSAGE_KIND[draft.type]!}
                    canRepeat={draft.type === 'tax_invoice'}
                    onRepeat={() => setOverlay('repeat')}
                  />
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
                {meta.status === 'issued' && (
                  <DropdownMenuItem
                    data-testid="doc-cancel"
                    disabled={meta.hasIrn || !mayCancel}
                    data-held={heldNote('cancel') ? 'true' : undefined}
                    onSelect={() => setCancelOpen(true)}
                  >
                    {heldNote('cancel') ? t('docs.approval.cancelAsk') : t('docs.cancel.action')}
                  </DropdownMenuItem>
                )}
                {isDraft && meta.id && (
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
            {meta.id && (
              <>
                <CollectOverlay
                  open={overlay === 'link' || overlay === 'qr' ? overlay : null}
                  documentId={meta.id}
                  onClose={() => setOverlay(null)}
                />
                <CustomerLinkOverlay
                  open={overlay === 'customer'}
                  target={{ documentId: meta.id }}
                  onClose={() => setOverlay(null)}
                />
                <RepeatOverlay
                  open={overlay === 'repeat'}
                  documentId={meta.id}
                  name={meta.number ?? ''}
                  start={todayIso()}
                  onClose={() => setOverlay(null)}
                />
              </>
            )}
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

      {creditFor && (
        <ApplyCreditBanner
          documentId={creditFor.id}
          number={creditFor.number}
          partyName={creditFor.party}
          onClose={() => setCreditFor(null)}
        />
      )}
      {meta.status === 'cancelled' && (
        <p
          role="status"
          className="rounded-md border border-danger p-2 text-sm text-danger"
          data-testid="doc-cancelled-banner"
        >
          {t('docs.cancel.banner', { reason: meta.cancelReason ?? '' })}
        </p>
      )}
      {editor.revising && (
        <p
          role="status"
          className="rounded-md border border-border bg-surface-1 p-2 text-sm"
          data-testid="doc-revising-banner"
        >
          {t('docs.revising')}
        </p>
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
            series={seriesQuery.data ?? []}
            seriesLocked={!isDraft}
            templates={templates.options}
            templateId={templateId}
            onTemplate={setPickedTemplate}
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
            issues={showIssues ? editor.issues : NO_ISSUES}
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
            onStockDetails={(row) => {
              if (draft.lines[row]?.itemId) setStockRow(row);
            }}
            stockText={stockText}
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
          <div inert className="offscreen">
            <DocumentPreview
              model={model}
              spec={spec}
              templates={templates.options}
              templateId={templateId}
              onTemplate={setPickedTemplate}
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
                {meta.id && !isDraft && portal?.on && (
                  <TabsTrigger value="einvoice" data-testid="tab-einvoice">
                    {t('einv.panel.title')}
                  </TabsTrigger>
                )}
                {meta.id && !isDraft && (
                  <TabsTrigger value="history" data-testid="tab-history">
                    {t('docs.history.tab')}
                  </TabsTrigger>
                )}
              </TabsList>
              <TabsContent value="preview" className="min-h-0 flex-1">
                <DocumentPreview
                  model={model}
                  spec={spec}
                  templates={templates.options}
                  templateId={templateId}
                  onTemplate={setPickedTemplate}
                />
              </TabsContent>
              {meta.id && !isDraft && portal?.on && (
                <TabsContent value="einvoice" className="min-h-0 flex-1 overflow-auto">
                  <EinvoicePanel
                    documentId={meta.id}
                    number={meta.number ?? ''}
                    type={draft.type}
                  />
                </TabsContent>
              )}
              {meta.id && !isDraft && (
                <TabsContent value="history" className="min-h-0 flex-1 overflow-auto">
                  <HistoryTab documentId={meta.id} version={meta.version} />
                  <DocumentMessages documentId={meta.id} />
                </TabsContent>
              )}
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

      {stockRow !== null && draft.lines[stockRow] && (
        <StockDetailsDialog
          line={draft.lines[stockRow]!}
          type={draft.type}
          reduceStock={draft.reduceStock}
          onClose={() => setStockRow(null)}
          onApply={(patch) => {
            const key = draft.lines[stockRow]?.key;
            setStockRow(null);
            if (!key) return;
            editor.setDraft((d) => updateLine(d, key, (l) => ({ ...l, ...patch })));
          }}
        />
      )}

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
      {cancelOpen && meta.number && (
        <CancelDialog
          number={meta.number}
          busy={busy}
          canCreditNote={targets.includes('credit_note')}
          onConfirm={(reason) => void doCancel(reason)}
          onCreditNote={() => {
            setCancelOpen(false);
            setConvertTo('credit_note');
          }}
          onClose={() => setCancelOpen(false)}
        />
      )}
      {overrideDialog}
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

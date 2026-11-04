import {
  ConflictError,
  DocumentFlowRepo,
  PeriodLockedError,
  SettingsRepo,
  type LockOverride,
  type Row,
} from '@gst/db';
import {
  buildDocument,
  defaultSaleType,
  draftFromRows,
  draftToRows,
  emptyDraft,
  isBlankDraft,
  today,
  validateForIssue,
  type BuiltDocument,
  type DocumentType,
  type DraftDocument,
  type DraftIssue,
} from '@gst/domain';
import { toast } from '@gst/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { newLineKey, withTrailingBlank } from './state';

import { useAppDb } from '@/app/db';
import { useUnsavedGuard } from '@/app/unsaved';
import { useFeatureFlags } from '@/features/business/hooks';

export const AUTOSAVE_MS = 2000;

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export interface DocMeta {
  id: string | null;
  version: number;
  status: 'draft' | 'issued' | 'cancelled';
  number: string | null;
  sourceDocumentId: string | null;
  /** 1 as first issued; each financial edit after issue adds one. */
  revision: number;
  cancelReason: string | null;
  /** An e-invoiced document cannot be changed or cancelled here. */
  hasIrn: boolean;
}

const NEW_META: DocMeta = {
  id: null,
  version: 0,
  status: 'draft',
  number: null,
  sourceDocumentId: null,
  revision: 1,
  cancelReason: null,
  hasIrn: false,
};

/** What a save, issue or cancel reports when it stopped at a locked period. */
export interface LockedStop {
  until: string;
}

export interface RevisionOutcome {
  ok: boolean;
  /** `financial` produced a new revision. */
  kind?: 'none' | 'non_financial' | 'financial';
  overAllocatedPaise?: number;
  locked?: LockedStop;
  error?: string;
}

/** A cheap signature of the editable state, to tell whether anything changed since the last save. */
const signature = (d: DraftDocument): string =>
  JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

export interface DocumentEditor {
  loading: boolean;
  notFound: boolean;
  draft: DraftDocument;
  setDraft: (f: (d: DraftDocument) => DraftDocument) => void;
  built: BuiltDocument;
  issues: DraftIssue[];
  meta: DocMeta;
  readOnly: boolean;
  saveState: SaveState;
  saveError: string | null;
  /** Save now. Resolves true when stored (or when there is nothing worth storing). */
  save: () => Promise<boolean>;
  /** The id of the stored draft right now (it exists once the first save has finished). */
  currentId: () => string | null;
  /**
   * Check, save and issue. `issues` lists what stopped it; empty with a `number` means it is issued.
   * `locked` means the date is in a closed period: ask an owner for a reason and call again with it.
   */
  issue: (
    override?: LockOverride,
  ) => Promise<{ issues: DraftIssue[]; number: string | null; locked?: LockedStop }>;
  discard: () => Promise<void>;
  /** Editing an issued document (notes always; amounts only in an open period). */
  revising: boolean;
  startRevision: () => void;
  cancelRevision: () => void;
  saveRevision: (override?: LockOverride) => Promise<RevisionOutcome>;
  cancel: (
    reason: string,
    override?: LockOverride,
  ) => Promise<{
    ok: boolean;
    locked?: LockedStop;
    error?: string;
    unallocated: { paymentId: string; amountPaise: number }[];
  }>;
}

/**
 * The state of one open document: loads it (or starts a blank one), prices it through the engine on
 * every change, saves a draft two seconds after the last edit, and issues it.
 */
export function useDocumentEditor(opts: {
  type: DocumentType;
  id: string | null;
  shell?: 'books' | 'shop';
}): DocumentEditor {
  const { t } = useTranslation();
  const { database, ctx, business } = useAppDb();
  const flags = useFeatureFlags();
  const scheme = business?.['scheme'] === 'composition' ? 'composition' : 'regular';
  const businessState: string = business?.['state_code'] ?? '';

  const [draft, setDraftState] = useState<DraftDocument>(() =>
    withTrailingBlank(
      emptyDraft(
        opts.type,
        today(() => new Date()),
        {
          supplierState: businessState,
          composition: scheme === 'composition' && opts.type === 'bill_of_supply',
        },
      ),
    ),
  );
  const [meta, setMeta] = useState<DocMeta>(NEW_META);
  const [revising, setRevising] = useState(false);
  const revisingRef = useRef(false);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(!!opts.id);
  const [notFound, setNotFound] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [gstinAbove, setGstinAbove] = useState(0n);

  const draftRef = useRef(draft);
  const metaRef = useRef(meta);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** Signature of what is stored, for rendering (state) and for the save logic (ref kept in step). */
  const [savedSig, setSavedSigState] = useState('');
  const savedSigRef = useRef('');
  const setSavedSig = useCallback((v: string) => {
    savedSigRef.current = v;
    setSavedSigState(v);
  }, []);
  useEffect(() => {
    draftRef.current = draft;
    metaRef.current = meta;
    revisingRef.current = revising;
  });

  // load an existing document
  useEffect(() => {
    if (!opts.id || !database || !ctx) return;
    let live = true;
    void (async () => {
      const found = await new DocumentFlowRepo(database).load(ctx, opts.id!);
      if (!live) return;
      if (!found) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      const loaded = withTrailingBlank(draftFromRows(found.document, found.lines, newLineKey));
      setSavedSig(signature(loaded));
      setDraftState(loaded);
      setMeta({
        id: found.document['id'],
        version: found.document['version'],
        status: found.document['status'],
        number: found.document['number'] ?? null,
        sourceDocumentId: found.document['source_document_id'] ?? null,
        revision: Number(found.document['revision'] ?? 1),
        cancelReason: found.document['cancel_reason'] ?? null,
        hasIrn: !!found.document['irn'],
      });
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [opts.id, database, ctx, setSavedSig, reload]);

  // the "GSTIN needed above" setting
  useEffect(() => {
    if (!database || !ctx) return;
    void new SettingsRepo(database)
      .getValue<string | number>(ctx, 'documents.gstin_required_above_paise')
      .then((v) => setGstinAbove(v ? BigInt(v) : 0n));
  }, [database, ctx]);

  const setDraft = useCallback((f: (d: DraftDocument) => DraftDocument) => {
    setDraftState((d) =>
      metaRef.current.status === 'draft' || revisingRef.current ? withTrailingBlank(f(d)) : d,
    );
  }, []);

  // Priced from the fields that affect money only, so editing a reference or a note does not produce a
  // new result (and does not redraw everything that shows it).
  const { lines, type: docType, date, supplierState, placeOfSupply, discountMode } = draft;
  const { sez, export: isExport, lut, reverseCharge, composition } = draft;
  const { invoiceDiscount, roundOff, tcs, tds } = draft;
  const built = useMemo(
    () =>
      buildDocument({
        ...emptyDraft(docType, date),
        lines,
        supplierState,
        placeOfSupply,
        discountMode,
        sez,
        export: isExport,
        lut,
        reverseCharge,
        composition,
        invoiceDiscount,
        roundOff,
        tcs,
        tds,
      }),
    [
      lines,
      docType,
      date,
      supplierState,
      placeOfSupply,
      discountMode,
      sez,
      isExport,
      lut,
      reverseCharge,
      composition,
      invoiceDiscount,
      roundOff,
      tcs,
      tds,
    ],
  );
  const issues = useMemo(
    () =>
      validateForIssue(
        draft,
        { scheme, gstinRequiredAbovePaise: gstinAbove, openTo: today(() => new Date()) },
        built,
      ),
    [draft, built, scheme, gstinAbove],
  );

  const sig = useMemo(() => signature(draft), [draft]);
  const readOnly = meta.status !== 'draft' && !revising;
  const dirty = !readOnly && sig !== savedSig && !isBlankDraft(draft);
  useUnsavedGuard(dirty && saveState !== 'saving');
  // what to show: a pending change reads as unsaved unless a save is running or has just failed
  const shownState: SaveState =
    saveState === 'idle' || saveState === 'saved' ? (dirty ? 'dirty' : saveState) : saveState;

  const doSave = useCallback(async (): Promise<boolean> => {
    if (!database || !ctx) return false;
    const d = draftRef.current;
    const m = metaRef.current;
    if (m.status !== 'draft') return true;
    if (isBlankDraft(d) && !m.id) return true;
    const at = signature(d);
    setSaveState('saving');
    try {
      const rows = draftToRows(d);
      const out = await new DocumentFlowRepo(database).saveDraft(ctx, {
        ...(m.id ? { id: m.id, version: m.version } : {}),
        doc: rows.doc as never,
        lines: rows.lines as never,
        sourceDocumentId: m.sourceDocumentId,
      });
      const next: DocMeta = {
        ...m,
        id: out.document['id'],
        version: out.document['version'],
      };
      metaRef.current = next;
      setMeta(next);
      setSavedSig(at);
      setSaveError(null);
      setSaveState(signature(draftRef.current) === at ? 'saved' : 'dirty');
      return true;
    } catch (e) {
      if (e instanceof ConflictError) {
        setSaveState('conflict');
        setSaveError(t('docs.save.conflict'));
      } else {
        setSaveState('error');
        setSaveError(e instanceof Error ? e.message : String(e));
      }
      return false;
    }
  }, [database, ctx, t, setSavedSig]);

  /** Saves never overlap: each waits for the one before it. */
  const save = useCallback((): Promise<boolean> => {
    const run = queue.current.then(doSave, doSave);
    queue.current = run;
    return run;
  }, [doSave]);

  // autosave two seconds after the last change
  useEffect(() => {
    if (loading || readOnly || revising || !dirty) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [sig, loading, readOnly, revising, dirty, save]);

  const issue = useCallback(
    async (
      override?: LockOverride,
    ): Promise<{ issues: DraftIssue[]; number: string | null; locked?: LockedStop }> => {
      const stop = (issues: DraftIssue[]) => ({ issues, number: null });
      if (!database || !ctx) return stop([]);
      const found = validateForIssue(draftRef.current, {
        scheme,
        gstinRequiredAbovePaise: gstinAbove,
        openTo: today(() => new Date()),
      });
      if (found.length > 0) return stop(found);
      if (!(await save())) return stop([{ field: 'save', code: 'save_failed' }]);
      const m = metaRef.current;
      if (!m.id) return stop([{ field: 'lines', code: 'no_lines' }]);
      try {
        const r = await new DocumentFlowRepo(database).issueDraft(ctx, m.id, m.version, {
          inventoryEnabled: flags.inventory,
          ...(opts.shell ? { shell: opts.shell } : {}),
          ...(override ? { lockOverride: override } : {}),
        });
        const next: DocMeta = {
          ...m,
          version: r.document['version'],
          status: 'issued',
          number: r.document['number'],
          revision: 1,
        };
        metaRef.current = next;
        setMeta(next);
        setSavedSig(signature(draftRef.current));
        setSaveState('saved');
        return { issues: [], number: r.document['number'] as string };
      } catch (e) {
        if (e instanceof PeriodLockedError)
          return { issues: [], number: null, locked: { until: e.until } };
        toast.error(e instanceof Error ? e.message : String(e));
        return stop([{ field: 'issue', code: 'issue_failed' }]);
      }
    },
    [database, ctx, scheme, gstinAbove, save, flags.inventory, setSavedSig, opts.shell],
  );

  const discard = useCallback(async () => {
    if (!database || !ctx) return;
    const m = metaRef.current;
    if (m.id && m.status === 'draft') {
      await new DocumentFlowRepo(database).discardDraft(ctx, m.id, m.version);
    }
    setSavedSig(signature(draftRef.current));
  }, [database, ctx, setSavedSig]);

  const startRevision = useCallback(() => {
    const m = metaRef.current;
    if (m.status === 'issued' && !m.hasIrn) setRevising(true);
  }, []);

  const cancelRevision = useCallback(() => {
    setRevising(false);
    setSaveState('idle');
    setSaveError(null);
    setReload((n) => n + 1);
  }, []);

  const saveRevision = useCallback(
    async (override?: LockOverride): Promise<RevisionOutcome> => {
      if (!database || !ctx) return { ok: false };
      const m = metaRef.current;
      const d = draftRef.current;
      if (!m.id || m.status !== 'issued') return { ok: false };
      const at = signature(d);
      setSaveState('saving');
      try {
        const rows = draftToRows(d);
        const out = await new DocumentFlowRepo(database).reviseIssued(
          ctx,
          { id: m.id, version: m.version, doc: rows.doc as never, lines: rows.lines as never },
          {
            inventoryEnabled: flags.inventory,
            ...(override ? { lockOverride: override } : {}),
          },
        );
        const next: DocMeta = {
          ...m,
          version: out.document['version'],
          revision: Number(out.document['revision'] ?? m.revision),
        };
        metaRef.current = next;
        setMeta(next);
        setSavedSig(at);
        setSaveError(null);
        setSaveState('saved');
        setRevising(false);
        return {
          ok: true,
          kind: out.kind,
          overAllocatedPaise: out.overAllocatedPaise,
        };
      } catch (e) {
        if (e instanceof PeriodLockedError) {
          setSaveState('idle');
          return { ok: false, locked: { until: e.until } };
        }
        const error =
          e instanceof ConflictError
            ? t('docs.save.conflict')
            : e instanceof Error
              ? e.message
              : String(e);
        setSaveState(e instanceof ConflictError ? 'conflict' : 'error');
        setSaveError(error);
        return { ok: false, error };
      }
    },
    [database, ctx, flags.inventory, setSavedSig, t],
  );

  const cancel = useCallback(
    async (reason: string, override?: LockOverride) => {
      const none: { paymentId: string; amountPaise: number }[] = [];
      if (!database || !ctx) return { ok: false, unallocated: none };
      const m = metaRef.current;
      if (!m.id) return { ok: false, unallocated: none };
      try {
        const out = await new DocumentFlowRepo(database).cancelDocument(
          ctx,
          m.id,
          m.version,
          reason,
          override ? { lockOverride: override } : {},
        );
        const next: DocMeta = {
          ...m,
          version: out.document['version'],
          status: 'cancelled',
          cancelReason: reason.trim(),
        };
        metaRef.current = next;
        setMeta(next);
        setRevising(false);
        return { ok: true, unallocated: out.unallocated };
      } catch (e) {
        if (e instanceof PeriodLockedError)
          return { ok: false, locked: { until: e.until }, unallocated: none };
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          unallocated: none,
        };
      }
    },
    [database, ctx],
  );

  return {
    revising,
    startRevision,
    cancelRevision,
    saveRevision,
    cancel,
    loading,
    notFound,
    draft,
    setDraft,
    built,
    issues,
    meta,
    readOnly,
    saveState: shownState,
    saveError,
    save,
    currentId: () => metaRef.current.id,
    issue,
    discard,
  };
}

/** The document type a business starts a new sale as: composition businesses issue bills of supply. */
export function defaultSaleFor(business: Row | null): DocumentType {
  return defaultSaleType(business?.['scheme'] === 'composition' ? 'composition' : 'regular');
}

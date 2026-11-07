/**
 * Tier 0 on the local database: load what the rules need, run them, and keep the inbox in step.
 *
 * - `runTier0` is idempotent: a finding already seen (in any state) is not raised again, and a waiting
 *   item whose condition has cleared is closed as expired.
 * - `applyReviewItem` / `acceptReviewItems` apply an accepted suggestion through the feature that owns the
 *   data, in one transaction, so a failure leaves both the data and the item untouched.
 * - Nothing is applied unless a person accepts, or has switched on a specific auto-rule (off by default).
 */
import {
  AttachmentRepo,
  BaseRepo,
  BusinessRepo,
  DocumentFlowRepo,
  GstrRepo,
  InventoryRepo,
  ItemRepo,
  PartyRepo,
  ReminderRepo,
  ReviewRepo,
  RuleError,
  partyBalancesIn,
  runInTx,
  type Ctx,
  type Database,
  type Row,
} from '@gst/db';
import { draftToRows, emptyDraft, emptyDraftLine, type DraftDocument } from '@gst/domain';
import { isLanguage, languageOfState, reminderText, type PrintLanguage } from '@gst/i18n';

import {
  detectBackupFailure,
  detectDuplicateItems,
  detectDuplicateParties,
  detectHsnSuggestions,
  detectLowStock,
  detectPrefilingIssues,
  detectRateChanges,
  detectReminders,
  detectStaleDrafts,
  type OverduePartyLite,
} from '../inbox/detectors';
import {
  BULK_MIN_CONFIDENCE,
  KIND_INFO,
  TIER0_KINDS,
  schemaFor,
  type AiExtractionItem,
  type SyncConflictItem,
  type DuplicateItemItem,
  type DuplicatePartyItem,
  type HsnSuggestionItem,
  type InboxKind,
  type RateChangeItem,
  type ReminderDueItem,
} from '../inbox/kinds';
import { reconcile, type Finding, type SeenLite } from '../inbox/lifecycle';

import { DbHsnLookup } from './adapters';
import { acceptReviewItem, createReviewItem } from './review';

const DAY = 86_400_000;
const IST = 5.5 * 3_600_000;

export interface Tier0Options {
  now?: number;
  /** Only these kinds (default: all of Tier 0). */
  kinds?: readonly InboxKind[];
  /** Stock reminders only make sense when the business tracks inventory. */
  inventoryEnabled?: boolean;
  /** The device's last backup failure, which lives outside the database. */
  backup?: { failedAt?: number | null; message?: string | null } | null;
  /** An explicit, user-enabled rule: accept HSN suggestions at or above this confidence (percent). */
  autoHsnMinConfidence?: number | null;
}

export interface Tier0Result {
  created: number;
  expired: number;
  autoAccepted: number;
  byKind: Record<string, number>;
}

const istDay = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);

const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: paise % 100 ? 2 : 0 })}`;

const running = new Map<string, Promise<Tier0Result>>();

/** Run the Tier 0 rules for one business. A second call while one is running shares its result. */
export function runTier0(db: Database, ctx: Ctx, opts: Tier0Options = {}): Promise<Tier0Result> {
  const key = ctx.businessId;
  const active = running.get(key);
  if (active) return active;
  const p = doRun(db, ctx, opts).finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

async function doRun(db: Database, ctx: Ctx, opts: Tier0Options): Promise<Tier0Result> {
  const now = opts.now ?? Date.now();
  const today = istDay(now);
  const want = new Set<string>(opts.kinds ?? TIER0_KINDS);
  const ran: string[] = [];
  const findings: Finding[] = [];
  const add = (kind: InboxKind, f: readonly Finding<unknown>[]) => {
    ran.push(kind);
    findings.push(...(f as Finding[]));
  };

  const parties = await new PartyRepo(db).list(ctx);
  const items = await new ItemRepo(db).list(ctx);
  const business = await new BusinessRepo(db).get(ctx, ctx.businessId);

  if (want.has('duplicate_party'))
    add(
      'duplicate_party',
      detectDuplicateParties(
        parties.map((p) => ({
          id: p['id'],
          name: p['name'],
          gstin: p['gstin'],
          phone: p['phone'],
          createdAt: Number(p['created_at']),
        })),
      ),
    );

  if (want.has('duplicate_item'))
    add(
      'duplicate_item',
      detectDuplicateItems(
        items.map((i) => ({
          id: i['id'],
          name: i['name'],
          kind: i['kind'] ?? 'product',
          barcode: i['barcode'],
          createdAt: Number(i['created_at']),
        })),
      ),
    );

  if (want.has('hsn_suggestion')) {
    const lookup = new DbHsnLookup(db, today);
    // an item whose suggestion was already answered is not searched again (a rejection is final)
    const answered = new Set<string>();
    for (const s of (await new ReviewRepo(db).seen(ctx, ['hsn_suggestion'])).values())
      if (s.status === 'rejected' || s.status === 'accepted')
        answered.add(s.dedupeKey.split(':')[1]!);
    add(
      'hsn_suggestion',
      await detectHsnSuggestions(
        items
          .filter((i) => !answered.has(String(i['id'])))
          .map((i) => ({
            id: i['id'],
            name: i['name'],
            hsn: i['hsn'],
            gstRateBp: Number(i['gst_rate_bp'] ?? 0),
            cessBp: Number(i['cess_bp'] ?? 0),
          })),
        (text) => lookup.search(text, 3),
      ),
    );
  }

  if (want.has('rate_change'))
    add('rate_change', detectRateChanges(await new ItemRepo(db).rateChanges(ctx, today)));

  if (want.has('draft_stale')) {
    const drafts = await new ReviewRepo(db).staleDrafts(ctx, now - 7 * DAY);
    add(
      'draft_stale',
      detectStaleDrafts(
        drafts.map((d) => ({
          id: d.id,
          label: [d.type.replace(/_/g, ' '), d.partyName].filter(Boolean).join(' · '),
          updatedAt: d.updatedAt,
        })),
        now,
      ),
    );
  }

  if (want.has('reminder_due')) {
    const bal = await runInTx(db, ctx, (tx) => partyBalancesIn(db, tx, ctx));
    const byParty = new Map<string, OverduePartyLite>();
    const info = new Map(parties.map((p) => [String(p['id']), p]));
    for (const doc of bal.docs) {
      if (doc.side !== 'receivable' || !doc.partyId || doc.balancePaise <= 0) continue;
      const late = dayNumber(today) - dayNumber(doc.dueDate ?? doc.date);
      if (late <= 0) continue;
      const party = info.get(doc.partyId);
      const cur = byParty.get(doc.partyId) ?? {
        partyId: doc.partyId,
        name: party?.['name'] ?? doc.partyName,
        phone: party?.['phone'] ?? null,
        stateCode: party?.['state_code'] ?? null,
        language: party?.['language'] ?? null,
        amountPaise: 0,
        invoices: 0,
        oldestDays: 0,
      };
      cur.amountPaise += doc.balancePaise;
      cur.invoices += 1;
      cur.oldestDays = Math.max(cur.oldestDays, late);
      byParty.set(doc.partyId, cur);
    }
    const businessName = String(business?.['trade_name'] || business?.['legal_name'] || '');
    add(
      'reminder_due',
      detectReminders([...byParty.values()], now, {
        // the language the party chose, else the one their state suggests
        languageOf: (s, chosen) => (isLanguage(chosen) ? chosen : languageOfState(s)),
        draft: (language, v) =>
          reminderText(language as PrintLanguage, {
            party: v.name,
            amount: inr(v.amountPaise),
            count: v.invoices,
            days: v.oldestDays,
            business: businessName,
          }),
      }),
    );
  }

  if (want.has('low_stock') && opts.inventoryEnabled)
    add(
      'low_stock',
      detectLowStock(
        (await new InventoryRepo(db).lowStock(ctx)).map((r) => ({
          id: r.itemId,
          name: r.name,
          onHandMicros: r.onHandMicros,
          minMicros: r.minMicros,
        })),
        now,
      ),
    );

  if (want.has('prefiling_issue')) {
    // the GST return check for last month and this month (nothing if the business does not file)
    const day = new Date(now + IST).toISOString().slice(0, 10);
    const found: Finding[] = [];
    for (const r of await new GstrRepo(db).recentIssues(ctx, day))
      found.push(...(detectPrefilingIssues(r.fp, r.issues) as Finding[]));
    add('prefiling_issue', found);
  }

  if (want.has('backup_failed') && opts.backup !== undefined)
    add('backup_failed', detectBackupFailure(opts.backup));

  const reviews = new ReviewRepo(db);
  const result: Tier0Result = { created: 0, expired: 0, autoAccepted: 0, byKind: {} };
  await runInTx(db, ctx, async (tx) => {
    const c: Ctx = { ...ctx, tx };
    const seen = await reviews.seen(c, ran);
    const lite = new Map<string, SeenLite>(
      [...seen].map(([k, s]) => [
        k,
        { id: s.id, status: s.status, version: s.version, kind: s.kind },
      ]),
    );
    const { create, expire } = reconcile(lite, findings, ran);
    for (const f of create) {
      await createReviewItem({
        db,
        ctx: c,
        kind: f.kind,
        payload: f.payload,
        suggestion: f.suggestion,
        schema: schemaFor(f.kind),
        source: 'rules',
        dedupeKey: f.key,
        ...(f.confidence === undefined ? {} : { confidence: f.confidence }),
      });
      result.created += 1;
      result.byKind[f.kind] = (result.byKind[f.kind] ?? 0) + 1;
    }
    result.expired = await reviews.expire(
      c,
      expire.map((e) => e.id),
    );
  });

  if (opts.autoHsnMinConfidence != null) {
    const rows = await reviews.inbox(ctx, { view: 'open', kinds: ['hsn_suggestion'], now });
    const sure = rows.filter((r) => Number(r['confidence'] ?? 0) >= opts.autoHsnMinConfidence!);
    if (sure.length > 0) {
      await acceptReviewItems(db, ctx, sure);
      result.autoAccepted = sure.length;
    }
  }
  return result;
}

/** The apply step for each kind. Runs inside the accept transaction (`ctx.tx` is set). */
async function applyValue(db: Database, ctx: Ctx, kind: string, value: any): Promise<void> {
  switch (kind as InboxKind) {
    case 'duplicate_party': {
      const v = value as DuplicatePartyItem;
      await new PartyRepo(db).merge(ctx, v.mergeId, v.keepId);
      return;
    }
    case 'duplicate_item': {
      const v = value as DuplicateItemItem;
      await new ItemRepo(db).merge(ctx, v.mergeId, v.keepId);
      return;
    }
    case 'hsn_suggestion': {
      const v = value as HsnSuggestionItem;
      const items = new ItemRepo(db);
      const item = await items.get(ctx, v.itemId);
      if (!item) throw new RuleError('that item no longer exists');
      await items.update(
        ctx,
        v.itemId,
        { hsn: v.code, gst_rate_bp: v.rateBp, cess_bp: v.cessBp },
        item['version'],
      );
      return;
    }
    case 'rate_change': {
      const v = value as RateChangeItem;
      const items = new ItemRepo(db);
      const item = await items.get(ctx, v.itemId);
      if (!item) throw new RuleError('that item no longer exists');
      await items.update(
        ctx,
        v.itemId,
        { gst_rate_bp: v.rateBp, cess_bp: v.cessBp },
        item['version'],
      );
      return;
    }
    case 'reminder_due': {
      // accepting records that the reminder was handled; sending is the person's own step
      const v = value as ReminderDueItem;
      await new ReminderRepo(db).create(ctx, {
        party_id: v.partyId,
        channel: 'manual',
        message: v.message,
        amount_paise: v.amountPaise,
        sent_at: Date.now(),
      });
      return;
    }
    case 'ai_extraction': {
      await applyExtraction(db, ctx, value as AiExtractionItem);
      return;
    }
    case 'sync_conflict': {
      await keepMine(db, ctx, value as SyncConflictItem);
      return;
    }
    case 'approval_request':
      // decided on the server, which holds the change: the inbox calls the cloud API for it
      throw new RuleError('an approval is decided with Approve or Decline, through the cloud');
    case 'low_stock':
    case 'draft_stale':
    case 'backup_failed':
    case 'prefiling_issue':
    case 'gsp_job_stopped':
      return; // acknowledging is all there is to do
    default: {
      const info = KIND_INFO[kind as InboxKind];
      throw new RuleError(
        `${info?.label ?? kind} items can't be applied yet${info?.pending ? ` (${info.pending})` : ''}`,
      );
    }
  }
}

/**
 * An accepted scan becomes a purchase draft: the engine prices the lines again (the bill's own total is
 * kept only in the metadata for the audit), the supplier and items are the ones the person confirmed, and
 * the scan is attached. The person issues it from the editor like any other draft.
 */
async function applyExtraction(db: Database, ctx: Ctx, v: AiExtractionItem): Promise<void> {
  const biz = await new BusinessRepo(db).get(ctx);
  if (!biz) throw new RuleError('no business');
  const own = String(biz['state_code'] ?? '');
  const supplierState = v.bill.supplierGstin ? v.bill.supplierGstin.slice(0, 2) : own;
  const party = v.supplierPartyId ? await new PartyRepo(db).get(ctx, v.supplierPartyId) : null;
  if (v.supplierPartyId && !party) throw new RuleError('that supplier no longer exists');
  const items = new ItemRepo(db);
  const draft: DraftDocument = {
    ...emptyDraft('purchase_bill', v.bill.date, { supplierState, composition: false }),
    partyId: party ? String(party['id']) : null,
    partyName: party ? String(party['name']) : v.bill.supplierName,
    partyGstin: party
      ? ((party['gstin'] as string | null) ?? v.bill.supplierGstin)
      : v.bill.supplierGstin,
    partyState: party ? ((party['state_code'] as string | null) ?? supplierState) : supplierState,
    supplierState: party ? String(party['state_code'] ?? supplierState) : supplierState,
    placeOfSupply: own,
    supplierInvoiceNo: v.bill.invoiceNumber,
    supplierInvoiceDate: v.bill.date,
    roundOff: true,
    lines: [],
  };
  for (const [i, l] of v.bill.lines.entries()) {
    const item = l.itemId ? await items.get(ctx, l.itemId) : null;
    if (l.itemId && !item) throw new RuleError(`the item on line ${i + 1} no longer exists`);
    draft.lines.push({
      ...emptyDraftLine(`x${i}`),
      itemId: item ? String(item['id']) : null,
      description: l.description,
      hsn: l.hsn ?? (item ? String(item['hsn'] ?? '') : ''),
      qtyMicros: BigInt(Math.round(l.qty * 1_000_000)),
      unitId: item ? ((item['unit_id'] as string | null) ?? null) : null,
      ratePaise: BigInt(l.ratePaise),
      gstRateBp: l.gstRateBp,
      cessBp: item ? Number(item['cess_bp'] ?? 0) : 0,
    });
  }
  const r = draftToRows(draft);
  const doc = r.doc as unknown as Record<string, unknown>;
  const saved = await new DocumentFlowRepo(db).saveDraft(ctx, {
    doc: {
      ...doc,
      id: v.documentId,
      metadata_json: {
        ...((doc['metadata_json'] as object | null) ?? {}),
        extraction: {
          billTotalPaise: v.bill.totalPaise,
          engineTotalPaise: Number(r.built.totals.totalPaise),
          sources: v.sources,
          model: v.model,
          fieldConfidence: v.fieldConfidence,
        },
      },
    } as never,
    lines: r.lines as unknown as Record<string, unknown>[],
  });
  if (v.attachment) {
    await new AttachmentRepo(db).register(ctx, {
      ownerTable: 'documents',
      ownerId: String(saved.document['id']),
      ...v.attachment,
    });
  }
}

const BOOKKEEPING = new Set([
  'id',
  'org_id',
  'business_id',
  'version',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
]);
const strip = (r: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => !BOOKKEEPING.has(k)));

/**
 * "Keep my version" of a sync conflict: apply what this device had on top of what the server kept. A draft
 * gets my header and my lines back (priced by the engine on save); any other row gets my values for the
 * fields I changed. A document that has been issued since cannot take a draft's edit: enter it again.
 */
async function keepMine(db: Database, ctx: Ctx, v: SyncConflictItem): Promise<void> {
  if (v.table === 'documents' || v.table === 'document_lines') {
    const docId =
      v.table === 'documents'
        ? v.rowId
        : String(v.mine['document_id'] ?? v.theirs['document_id'] ?? '');
    const flow = new DocumentFlowRepo(db);
    const current = await flow.load(ctx, docId);
    if (!current) throw new RuleError('that document no longer exists');
    if (current.document['status'] !== 'draft')
      throw new RuleError(
        'that document was issued on another device since; enter your change as a revision or a new document',
      );
    const docOp = v.ops.find((o) => o.table === 'documents' && o.id === docId);
    const lineOps = v.ops.filter(
      (o) =>
        o.table === 'document_lines' && o.op === 'PUT' && o.data && o.data['deleted_at'] == null,
    );
    const kept = new Set(['status', 'number', 'series_id', 'deleted_at']);
    const docPatch = Object.fromEntries(
      Object.entries(strip(docOp?.data ?? {})).filter(([k]) => !kept.has(k)),
    );
    const lines = lineOps.length
      ? lineOps
          .map((o) => strip(o.data!))
          .sort((a, b) => Number(a['line_no']) - Number(b['line_no']))
      : current.lines.map((l) => strip(l as Record<string, unknown>));
    await flow.saveDraft(ctx, {
      id: docId,
      version: Number(current.document['version']),
      doc: { ...strip(current.document as Record<string, unknown>), ...docPatch },
      lines,
    });
    return;
  }
  const repo = new BaseRepo(db, v.table as never);
  const row = await repo.get(ctx, v.rowId);
  if (!row) throw new RuleError('that record no longer exists');
  const patch = strip(v.mine);
  delete patch['deleted_at'];
  if (!Object.keys(patch).length) return;
  await repo.update(ctx, v.rowId, patch, Number(row['version']));
}

/** Accept one item, applying it (or the edited version of it) in one transaction. */
export function applyReviewItem(db: Database, ctx: Ctx, item: Row, edited?: unknown): Promise<Row> {
  const kind = String(item['kind']);
  return acceptReviewItem({
    db,
    ctx,
    id: item['id'],
    expectedVersion: item['version'],
    schema: schemaFor(kind),
    apply: (value, c) => applyValue(db, c, kind, value),
    ...(edited === undefined ? {} : { edited }),
  });
}

/** Accept several in one transaction: all of them, or (if one fails) none. */
export function acceptReviewItems(db: Database, ctx: Ctx, items: readonly Row[]): Promise<Row[]> {
  return runInTx(db, ctx, async (tx) => {
    const c: Ctx = { ...ctx, tx };
    const out: Row[] = [];
    for (const it of items) out.push(await applyReviewItem(db, c, it));
    return out;
  });
}

/** What the bulk-accept dialog may offer: homogeneous, low-risk and sure enough. */
export function bulkCandidates(rows: readonly Row[], minConfidence = BULK_MIN_CONFIDENCE): Row[] {
  return rows.filter(
    (r) => KIND_INFO[r['kind'] as InboxKind]?.bulk && Number(r['confidence'] ?? 0) >= minConfidence,
  );
}

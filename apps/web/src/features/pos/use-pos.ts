import {
  DocumentFlowRepo,
  ItemRepo,
  PartyRepo,
  PosRepo,
  SettingsRepo,
  type Counter,
  type Database,
  type HeldBill,
  type Row,
  type Shift,
} from '@gst/db';
import { buildDocument, draftFromRows } from '@gst/domain';
import type { PrintModel, TemplateSpec } from '@gst/print';
import { useCallback, useMemo } from 'react';

import { buildIndex, DEFAULT_POS_SETTINGS, type ItemIndex, type PosSettings } from './model';

import { useAppDb, useLiveQuery } from '@/app/db';
import { newLineKey } from '@/features/documents/state';
import { modelNow, usePrintContext } from '@/features/print/use-print-model';
import {
  specOf,
  useDefaultTemplateId,
  useTemplates,
  withPartyLanguage,
} from '@/features/print/use-templates';

const SETTINGS_KEY = 'pos.settings';

export function usePosSettings() {
  const q = useLiveQuery<PosSettings>({
    tables: ['settings'],
    key: ['pos-settings'],
    fn: async (d, c) => ({
      ...DEFAULT_POS_SETTINGS,
      ...((await new SettingsRepo(d).getValue<Partial<PosSettings>>(c, SETTINGS_KEY)) ?? {}),
    }),
  });
  return q.data ?? DEFAULT_POS_SETTINGS;
}

export async function savePosSettings(
  d: Database,
  c: Parameters<SettingsRepo['set']>[0],
  s: PosSettings,
): Promise<void> {
  await new SettingsRepo(d).set(c, SETTINGS_KEY, s);
}

export function useCounters() {
  return useLiveQuery<Counter[]>({
    tables: ['pos_counters', 'number_series'],
    key: ['pos-counters'],
    fn: (d, c) => new PosRepo(d).allCounters(c),
  });
}

export function useShift(counterId: string | null) {
  return useLiveQuery<Shift | null>({
    tables: ['pos_shifts'],
    key: ['pos-shift', counterId],
    enabled: !!counterId,
    fn: (d, c) => new PosRepo(d).currentShift(c, counterId!),
  });
}

export function useHeld(counterId: string | null) {
  return useLiveQuery<HeldBill[]>({
    tables: ['pos_held_bills'],
    key: ['pos-held', counterId],
    enabled: !!counterId,
    fn: (d, c) => new PosRepo(d).heldBills(c, counterId!),
  });
}

/** Every item, and the index a scan looks up in. Rebuilt only when items change. */
export function useItems() {
  const q = useLiveQuery<Row[]>({
    tables: ['items'],
    key: ['pos-items'],
    fn: (d, c) => new ItemRepo(d).list(c),
  });
  const items = q.data;
  const index = useMemo<ItemIndex | null>(() => (items ? buildIndex(items) : null), [items]);
  return { items: items ?? null, index };
}

/** The items sold most, for the quick keys; the first few items until there is a history. */
export function useQuickItems(items: Row[] | null, limit = 12): Row[] {
  const q = useLiveQuery<string[]>({
    tables: ['documents', 'document_lines'],
    key: ['pos-top', limit],
    fn: (d, c) => new PosRepo(d).topItems(c, limit),
  });
  return useMemo(() => {
    if (!items) return [];
    const byId = new Map(items.map((i) => [String(i['id']), i]));
    const top = (q.data ?? []).map((id) => byId.get(id)).filter((x): x is Row => !!x);
    if (top.length >= limit) return top;
    const have = new Set(top.map((i) => String(i['id'])));
    const filler = items.filter((i) => !have.has(String(i['id'])) && i['is_active'] !== false);
    return [...top, ...filler.slice(0, limit - top.length)];
  }, [items, q.data, limit]);
}

/**
 * The receipt of a bill already issued, from the stored document: the same template and engine as the
 * editor, so a reprint matches the original. Used for the sale just made and for reprints.
 */
export function useReceiptMaker(documentType: 'tax_invoice' | 'bill_of_supply') {
  const { database, ctx } = useAppDb();
  const printContext = usePrintContext();
  const templates = useTemplates();
  const templateId = useDefaultTemplateId(documentType, 'shop');
  return useCallback(
    async (documentId: string): Promise<{ model: PrintModel; spec: TemplateSpec } | null> => {
      if (!database || !ctx || !printContext) return null;
      const loaded = await new DocumentFlowRepo(database).load(ctx, documentId);
      if (!loaded) return null;
      const draft = draftFromRows(loaded.document as never, loaded.lines as never, newLineKey);
      const built = buildDocument(draft);
      const partyId = loaded.document['party_id'] as string | null;
      const party = partyId ? await new PartyRepo(database).get(ctx, partyId) : null;
      const model = modelNow(printContext, {
        draft,
        built,
        number: (loaded.document['number'] as string | null) ?? null,
        status: loaded.document['status'] as never,
        revision: Number(loaded.document['revision'] ?? 1),
        party,
        einvoice: null,
        eway: null,
      });
      const spec = withPartyLanguage(specOf(templates.options, templateId), model.party);
      return { model, spec };
    },
    [database, ctx, printContext, templates.options, templateId],
  );
}

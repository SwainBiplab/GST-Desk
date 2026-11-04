/**
 * Bulk edit planning: work out what each selected item would become, without touching storage.
 * The UI shows the plan as a preview; the repository applies it and can reverse it.
 * Percent changes use integer basis points and round half away from zero, like all money.
 */
import { BP, mulDivRound } from './money';

export const PRICE_FIELDS = ['sale_rate_paise', 'purchase_rate_paise', 'mrp_paise'] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

export type BulkChange =
  | { kind: 'gst_rate'; rateBp: number; cessBp?: number }
  | { kind: 'price'; field: PriceField; mode: 'percent'; percentBp: number }
  | { kind: 'price'; field: PriceField; mode: 'amount'; deltaPaise: number }
  | { kind: 'tag'; op: 'add' | 'remove'; tag: string };

export interface BulkItem {
  id: string;
  version: number;
  name: string;
  sale_rate_paise: number | null;
  purchase_rate_paise: number | null;
  mrp_paise: number | null;
  gst_rate_bp: number | null;
  cess_bp: number | null;
  tags_json: string[] | null;
}

export type BulkSkip = 'no_price' | 'negative' | 'unchanged';

export interface BulkPlanEntry {
  id: string;
  version: number;
  name: string;
  /** Only the fields that change: `before` is what undo restores. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  skipped?: BulkSkip;
}

const norm = (tag: string) => tag.trim().replace(/\s+/g, ' ');

export function planBulkEdit(items: readonly BulkItem[], change: BulkChange): BulkPlanEntry[] {
  return items.map((it): BulkPlanEntry => {
    const base = { id: it.id, version: it.version, name: it.name };
    const skip = (skipped: BulkSkip): BulkPlanEntry => ({
      ...base,
      before: {},
      after: {},
      skipped,
    });

    if (change.kind === 'gst_rate') {
      const cess = change.cessBp ?? it.cess_bp;
      if (it.gst_rate_bp === change.rateBp && it.cess_bp === cess) return skip('unchanged');
      return {
        ...base,
        before: { gst_rate_bp: it.gst_rate_bp, cess_bp: it.cess_bp },
        after: { gst_rate_bp: change.rateBp, cess_bp: cess },
      };
    }

    if (change.kind === 'price') {
      const old = it[change.field];
      if (old === null || old === undefined) return skip('no_price');
      const next =
        change.mode === 'percent'
          ? mulDivRound(BigInt(old), BP + BigInt(change.percentBp), BP)
          : BigInt(old) + BigInt(change.deltaPaise);
      if (next < 0n) return skip('negative');
      if (next === BigInt(old)) return skip('unchanged');
      return { ...base, before: { [change.field]: old }, after: { [change.field]: Number(next) } };
    }

    const tag = norm(change.tag);
    const tags = it.tags_json ?? [];
    const has = tags.some((x) => x.toLowerCase() === tag.toLowerCase());
    if (tag === '' || (change.op === 'add' ? has : !has)) return skip('unchanged');
    const after =
      change.op === 'add'
        ? [...tags, tag]
        : tags.filter((x) => x.toLowerCase() !== tag.toLowerCase());
    return { ...base, before: { tags_json: it.tags_json }, after: { tags_json: after } };
  });
}

/** Entries that will actually change something. */
export const changed = (plan: readonly BulkPlanEntry[]) => plan.filter((p) => !p.skipped);

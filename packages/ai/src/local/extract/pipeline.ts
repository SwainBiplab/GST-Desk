/**
 * `extractPurchaseBill`: pixels (or text) in, a reviewed proposal out. OCR, then the rules extractor and,
 * when a Tier 1 or 2 backend is on, the model; the two are merged field by field with the agreement raising
 * the confidence. The supplier and the lines are matched to the books, and the engine prices the lines so
 * a total that does not add up is flagged before anyone sees it.
 */
import { buildDocument, emptyDraft, emptyDraftLine, type DraftDocument } from '@gst/domain';

import type { AiResult } from '../../provider';
import type { AiRouter } from '../../router';
import { purchaseBillSchema, type PurchaseBill } from '../../schemas';
import { layoutText, meanConfidence } from '../ocr/layout';
import { prepare } from '../ocr/preprocess';
import type { OcrEngine, OcrResult, RasterImage } from '../ocr/types';

import {
  matchItem,
  matchSupplier,
  type ItemMatch,
  type ItemRef,
  type PartyRef,
  type SupplierMatch,
} from './match';
import { extractBillFromText } from './rules';

export type ExtractionSource =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: RasterImage }
  | { kind: 'images'; images: RasterImage[] };

export type ExtractionStep = 'prepare' | 'ocr' | 'rules' | 'model' | 'match' | 'check';

export interface ExtractionChecks {
  /** What the engine makes of the lines, in paise. */
  engineTotalPaise: number;
  /** The engine's total before tax. */
  engineTaxablePaise: number;
  /** The bill's own total, from the text. */
  billTotalPaise: number;
  /** True when the two are within a rupee. */
  totalsAgree: boolean;
  /** True when the GSTIN passed its check character. */
  gstinValid: boolean | null;
  /** True when the date is not in the future and not older than two years. */
  dateSane: boolean;
}

export interface ExtractionResult {
  bill: PurchaseBill;
  fieldConfidence: Record<string, number>;
  /** Overall, 0..1. */
  confidence: number;
  supplier: SupplierMatch;
  lineMatches: ItemMatch[];
  checks: ExtractionChecks;
  ocr: { text: string; engine: string; confidence: number; angle: number; pages: number } | null;
  /** Which backends answered: `rules`, and the model's provider when it did. */
  sources: string[];
  model: string | null;
  timings: Partial<Record<ExtractionStep, number>>;
}

export interface ExtractionOptions {
  ocr?: OcrEngine;
  router?: AiRouter;
  parties: PartyRef[];
  items: ItemRef[];
  ownGstin?: string | null;
  rateForHsn?: (hsn: string) => number | null;
  businessState: string;
  languages?: string[];
  allowCloud?: boolean;
  signal?: AbortSignal;
  onStep?: (step: ExtractionStep) => void;
  today?: string;
}

const gstinOk = (g: string | null, conf: number): boolean | null => (g ? conf >= 0.9 : null);

/** The engine's figures for the lines, through the same code that prices a document in the editor. */
export function engineTotals(
  bill: PurchaseBill,
  businessState: string,
  supplierState: string | null,
): { totalPaise: number; taxablePaise: number } {
  const draft: DraftDocument = {
    ...emptyDraft('purchase_bill', bill.date, {
      supplierState: supplierState ?? businessState,
      composition: false,
    }),
    partyName: bill.supplierName,
    partyGstin: bill.supplierGstin,
    placeOfSupply: businessState,
    supplierState: supplierState ?? businessState,
    lines: bill.lines.map((l, i) => ({
      ...emptyDraftLine(`l${i}`),
      description: l.description,
      hsn: l.hsn ?? '',
      qtyMicros: BigInt(Math.round(l.qty * 1_000_000)),
      ratePaise: BigInt(l.ratePaise),
      gstRateBp: l.gstRateBp,
    })),
    roundOff: true,
  };
  const built = buildDocument(draft);
  return {
    totalPaise: Number(built.totals.totalPaise),
    taxablePaise: Number(built.totals.taxablePaise),
  };
}

function merge(
  rules: PurchaseBill,
  rulesConf: Record<string, number>,
  model: PurchaseBill | null,
): { bill: PurchaseBill; conf: Record<string, number> } {
  if (!model) return { bill: rules, conf: rulesConf };
  const conf: Record<string, number> = {};
  const pick = <K extends keyof PurchaseBill>(
    k: K,
    same: (a: PurchaseBill[K], b: PurchaseBill[K]) => boolean,
  ): PurchaseBill[K] => {
    const r = rules[k];
    const m = model[k];
    const rc = rulesConf[k] ?? 0.3;
    const blank = (v: unknown) =>
      v === null || v === '' || v === 0 || (Array.isArray(v) && v.length === 0);
    if (blank(m)) {
      conf[k] = rc;
      return r;
    }
    if (blank(r)) {
      conf[k] = 0.6;
      return m;
    }
    if (same(r, m)) {
      conf[k] = Math.min(0.98, Math.max(rc, 0.6) + 0.15);
      return m;
    }
    // they disagree: the more confident side wins, and the field is marked for a look
    if (rc >= 0.85) {
      conf[k] = rc - 0.2;
      return r;
    }
    conf[k] = 0.5;
    return m;
  };
  const eq = <T>(a: T, b: T) => a === b;
  const normStr = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const bill: PurchaseBill = {
    supplierName: pick('supplierName', normStr),
    supplierGstin: pick(
      'supplierGstin',
      (a, b) => (a ?? '').toUpperCase() === (b ?? '').toUpperCase(),
    ),
    invoiceNumber: pick('invoiceNumber', normStr),
    date: pick('date', eq),
    lines: pick(
      'lines',
      (a, b) =>
        a.length === b.length &&
        a.every((l, i) => Math.abs(l.ratePaise - b[i]!.ratePaise) <= 1 && l.qty === b[i]!.qty),
    ),
    totalPaise: pick('totalPaise', (a, b) => Math.abs(a - b) <= 100),
  };
  return { bill, conf };
}

export async function extractPurchaseBill(
  source: ExtractionSource,
  o: ExtractionOptions,
): Promise<ExtractionResult> {
  const timings: Partial<Record<ExtractionStep, number>> = {};
  const step = async <T>(name: ExtractionStep, fn: () => Promise<T> | T): Promise<T> => {
    o.onStep?.(name);
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      timings[name] = Math.round(performance.now() - t0);
    }
  };

  // text, from OCR when needed
  let text = '';
  let ocr: ExtractionResult['ocr'] = null;
  if (source.kind === 'text') text = source.text;
  else {
    if (!o.ocr) throw new Error('no OCR engine');
    const images = source.kind === 'image' ? [source.image] : source.images;
    const prepared = await step('prepare', () => images.map((im) => prepare(im)));
    const results: OcrResult[] = await step('ocr', async () => {
      const out: OcrResult[] = [];
      for (const p of prepared)
        out.push(
          await o.ocr!.recognise(p.image, {
            ...(o.languages ? { languages: o.languages } : {}),
            ...(o.signal ? { signal: o.signal } : {}),
          }),
        );
      return out;
    });
    text = results.map(layoutText).join('\n\n');
    ocr = {
      text,
      engine: results[0]?.engine ?? o.ocr.id,
      confidence: meanConfidence(results.flatMap((r) => r.boxes)),
      angle: prepared[0]?.angle ?? 0,
      pages: images.length,
    };
  }

  const rules = await step('rules', () =>
    extractBillFromText(text, {
      ownGstin: o.ownGstin ?? null,
      ...(o.rateForHsn ? { rateForHsn: o.rateForHsn } : {}),
    }),
  );
  let modelBill: PurchaseBill | null = null;
  let modelName: string | null = null;
  const sources = ['rules'];
  if (o.router && text.trim()) {
    const r: AiResult<PurchaseBill> = await step('model', () =>
      o.router!.extract({ kind: 'text', text }, purchaseBillSchema, {
        schemaName: 'purchaseBill',
        feature: 'bill_extract',
        ...(o.allowCloud !== undefined ? { allowCloud: o.allowCloud } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      }),
    );
    if (r.ok && r.provider !== 'rules') {
      modelBill = r.value;
      modelName = `${r.provider}:${r.model}`;
      sources.push(r.provider);
    }
  }
  const { bill, conf } = merge(rules.bill, rules.fieldConfidence, modelBill);

  const supplier = await step('match', () => matchSupplier(bill, o.parties));
  const lineMatches = bill.lines.map((l) => matchItem(l, o.items));

  const checks = await step('check', (): ExtractionChecks => {
    const supplierState = bill.supplierGstin ? bill.supplierGstin.slice(0, 2) : null;
    const t = engineTotals(bill, o.businessState, supplierState);
    const today = o.today ?? new Date().toISOString().slice(0, 10);
    const twoYearsAgo = `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
    return {
      engineTotalPaise: t.totalPaise,
      engineTaxablePaise: t.taxablePaise,
      billTotalPaise: bill.totalPaise,
      totalsAgree: Math.abs(t.totalPaise - bill.totalPaise) <= 100,
      gstinValid: gstinOk(bill.supplierGstin, conf['supplierGstin'] ?? 0),
      dateSane: bill.date <= today && bill.date >= twoYearsAgo,
    };
  });
  if (!checks.totalsAgree) {
    conf['totalPaise'] = Math.min(conf['totalPaise'] ?? 0.5, 0.45);
    conf['lines'] = Math.min(conf['lines'] ?? 0.5, 0.45);
  }
  if (!checks.dateSane) conf['date'] = Math.min(conf['date'] ?? 0.5, 0.4);
  const ocrFactor = ocr ? 0.6 + 0.4 * ocr.confidence : 1;
  const fields = ['supplierName', 'supplierGstin', 'invoiceNumber', 'date', 'lines', 'totalPaise'];
  const confidence =
    Math.round(
      (fields.reduce((a, f) => a + (conf[f] ?? 0.3), 0) / fields.length) * ocrFactor * 100,
    ) / 100;

  return {
    bill,
    fieldConfidence: conf,
    confidence,
    supplier,
    lineMatches,
    checks,
    ocr,
    sources,
    model: modelName,
    timings,
  };
}

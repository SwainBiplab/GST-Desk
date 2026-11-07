/**
 * A bill file becomes an inbox card: the file is kept (attachments store), the pages are read, the
 * fields are extracted and matched, and a review item is created. Nothing touches the books until the
 * person accepts the card.
 */
import {
  extractPurchaseBill,
  type AiRouter,
  type ExtractionResult,
  type ExtractionStep,
  type OcrEngine,
} from '@gst/ai';
import { aiExtractionItem, type AiExtractionItem } from '@gst/ai';
import { createReviewItem } from '@gst/ai/db';
import {
  ItemRepo,
  PartyRepo,
  ReviewRepo,
  newId,
  searchHsn,
  type Ctx,
  type Database,
  type Row,
} from '@gst/db';

import { checkAttachment } from '../documents/files';

import { rasterise } from './raster';

import { putBlob } from '@/app/blobs';

export type ScanStep = ExtractionStep | 'read' | 'store' | 'inbox';

export interface ScanOutcome {
  reviewItemId: string;
  documentId: string;
  result: ExtractionResult;
}

export class ScanError extends Error {
  constructor(
    readonly code: 'empty' | 'too_big' | 'type' | 'no_ocr' | 'no_text' | 'duplicate',
    message = code,
  ) {
    super(message);
    this.name = 'ScanError';
  }
}

export interface ScanOptions {
  db: Database;
  ctx: Ctx;
  business: Row;
  ocr: OcrEngine | null;
  router: AiRouter | null;
  languages: string[];
  allowCloud?: boolean;
  signal?: AbortSignal;
  onStep?: (step: ScanStep) => void;
  /** Review items already raised for this file hash, so the same scan is not raised twice. */
  seenHashes?: Set<string>;
}

/** The rate for an HSN from the master, used for lines whose bill prints no rate. */
async function rateLookup(db: Database): Promise<(hsn: string) => number | null> {
  const cache = new Map<string, number | null>();
  // searchHsn is by text; a code is its own best search term
  return (hsn) => {
    if (cache.has(hsn)) return cache.get(hsn)!;
    cache.set(hsn, null);
    void searchHsn(db, hsn, { limit: 1 }).then((h) => {
      if (h[0]?.code === hsn) cache.set(hsn, h[0].rate_bp);
    });
    return null;
  };
}

export async function scanFile(
  file: { name: string; bytes: Uint8Array },
  o: ScanOptions,
): Promise<ScanOutcome> {
  const step = (s: ScanStep) => o.onStep?.(s);
  step('read');
  const check = checkAttachment(file.bytes);
  if (!check.ok) throw new ScanError(check.reason);
  const pages = await rasterise(file.bytes, check.mime);
  if (!o.ocr) throw new ScanError('no_ocr');

  step('store');
  const stored = await putBlob(new Blob([file.bytes as BlobPart], { type: check.mime }));
  // the same file again (any state: a rejected scan is not raised twice either)
  const seen =
    o.seenHashes ?? new Set((await new ReviewRepo(o.db).seen(o.ctx, ['ai_extraction'])).keys());
  if (seen.has(stored.sha256) || seen.has(`ai_extraction:${stored.sha256}`))
    throw new ScanError('duplicate');

  const [parties, items] = await Promise.all([
    new PartyRepo(o.db).list(o.ctx),
    new ItemRepo(o.db).list(o.ctx),
  ]);
  const rateForHsn = await rateLookup(o.db);
  const result = await extractPurchaseBill(
    pages.length === 1 ? { kind: 'image', image: pages[0]! } : { kind: 'images', images: pages },
    {
      ocr: o.ocr,
      ...(o.router ? { router: o.router } : {}),
      parties: parties.map((p) => ({
        id: String(p['id']),
        name: String(p['name']),
        gstin: (p['gstin'] as string | null) ?? null,
      })),
      items: items.map((i) => ({
        id: String(i['id']),
        name: String(i['name']),
        hsn: (i['hsn'] as string | null) ?? null,
        purchaseRatePaise: Number(i['purchase_rate_paise'] ?? 0),
        gstRateBp: Number(i['gst_rate_bp'] ?? 0),
      })),
      ownGstin: (o.business['gstin'] as string | null) ?? null,
      businessState: String(o.business['state_code'] ?? ''),
      rateForHsn,
      languages: o.languages,
      ...(o.allowCloud !== undefined ? { allowCloud: o.allowCloud } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      onStep: step,
    },
  );
  if (!result.ocr?.text.trim()) throw new ScanError('no_text');

  step('inbox');
  const documentId = newId();
  const suggestion: AiExtractionItem = {
    documentId,
    bill: {
      ...result.bill,
      lines: result.bill.lines.map((l, i) => ({
        ...l,
        itemId: result.lineMatches[i]?.itemId ?? null,
      })),
    },
    supplierPartyId: result.supplier.partyId,
    fieldConfidence: result.fieldConfidence,
    checks: {
      engineTotalPaise: result.checks.engineTotalPaise,
      totalsAgree: result.checks.totalsAgree,
      gstinValid: result.checks.gstinValid,
      dateSane: result.checks.dateSane,
    },
    attachment: {
      fileName: file.name,
      mime: check.mime,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storagePath: stored.storagePath,
    },
    sources: result.sources,
    model: result.model,
  };
  const item = await createReviewItem({
    db: o.db,
    ctx: o.ctx,
    kind: 'ai_extraction',
    payload: {
      fileName: file.name,
      sha256: stored.sha256,
      ocrText: result.ocr.text.slice(0, 20_000),
      ocrEngine: result.ocr.engine,
      ocrConfidence: result.ocr.confidence,
      supplierMatch: result.supplier,
      lineMatches: result.lineMatches,
      timings: result.timings,
    },
    suggestion,
    schema: aiExtractionItem,
    source: result.model ? result.model.split(':')[0]! : 'rules',
    ...(result.model ? { model: result.model } : {}),
    confidence: result.confidence,
    dedupeKey: `ai_extraction:${stored.sha256}`,
  });
  return { reviewItemId: String(item['id']), documentId, result };
}

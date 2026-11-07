/**
 * The PDF of a stored document, made on the server for the message that carries it (prompt 44): the same
 * print model and layout the app prints from, in the classic template and the party's language. The logo is
 * left out (its bytes live in the device's file store, not in the cloud tier yet).
 */
import {
  BaseRepo,
  BusinessAccountRepo,
  BusinessRepo,
  DocumentFlowRepo,
  PartyRepo,
  type Ctx,
  type Row,
} from '@gst/db';
import {
  FontMeasurer,
  SCRIPT_FAMILY,
  buildStoredPrintModel,
  familiesIn,
  layoutDocument,
  presetSpec,
  printAccount,
  printBusiness,
  printParty,
  printShipTo,
  renderPdf,
  type FontFamily,
  type PrintModel,
} from '@gst/print';
import { loadFontsNode } from '@gst/print/fonts.node';

import type { PgDatabase } from '../db/pool';

export interface RenderedDocument {
  bytes: Uint8Array;
  fileName: string;
  model: PrintModel;
  document: Row;
  party: Row | null;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export async function renderDocumentPdf(
  db: PgDatabase,
  ctx: Ctx,
  documentId: string,
): Promise<RenderedDocument | null> {
  const found = await new DocumentFlowRepo(db).load(ctx, documentId);
  if (!found) return null;
  const doc = found.document;
  const business = await new BusinessRepo(db).get(ctx);
  if (!business) return null;
  const [accounts, units, party] = await Promise.all([
    new BusinessAccountRepo(db).forDocuments(ctx),
    new BaseRepo(db, 'units').list(ctx),
    doc['party_id'] ? new PartyRepo(db).get(ctx, doc['party_id']) : Promise.resolve(null),
  ]);
  // the live payment link for what is owed (prompt 45), if the business collects online
  const [live] = await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${ctx.orgId}, true)`;
    return tx`SELECT url FROM payment_requests WHERE org_id = ${ctx.orgId} AND document_id = ${documentId} AND kind = 'link'
      AND status IN ('created', 'partial') AND expires_at > ${Date.now()} AND url IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
  });
  const model = buildStoredPrintModel({
    payLink: (live?.['url'] as string | undefined) ?? null,
    document: doc,
    lines: found.lines,
    business: printBusiness(business, null),
    party: party
      ? printParty(party)
      : doc['party_name']
        ? {
            name: String(doc['party_name']),
            gstin: null,
            address: [],
            stateName: null,
            phone: null,
          }
        : null,
    shipTo: printShipTo(party),
    accounts: accounts.map(printAccount),
    units: new Map(units.map((u) => [String(u['id']), String(u['code'])])),
  });
  const base = presetSpec('classic');
  const language =
    model.party && 'language' in model.party && model.party.language
      ? model.party.language
      : base.language;
  const spec = { ...base, language };
  const families = new Set<FontFamily>(['latin', 'latinExt']);
  const script = SCRIPT_FAMILY[spec.language];
  if (script) families.add(script);
  for (const f of familiesIn(
    JSON.stringify(model, (_k, v) => (typeof v === 'bigint' ? '' : v)) +
      JSON.stringify(spec.labels),
  ))
    families.add(f);
  const fonts = loadFontsNode([...families].sort());
  const laid = layoutDocument(model, spec, { measurer: new FontMeasurer(fonts) });
  const bytes = await renderPdf(laid.pages, fonts, {
    title: `${String(doc['number'] ?? 'Document')}`,
    author: model.business.name,
    created: new Date(`${String(doc['date'])}T00:00:00Z`),
  });
  return {
    bytes,
    fileName: `${safe(`${model.business.name}_${String(doc['number'] ?? doc['id'])}`)}.pdf`,
    model,
    document: doc,
    party,
  };
}

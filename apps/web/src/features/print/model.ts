import {
  AttachmentRepo,
  BaseRepo,
  BusinessAccountRepo,
  BusinessRepo,
  DocumentFlowRepo,
  PartyRepo,
  type Ctx,
  type Database,
  type Row,
} from '@gst/db';
import { STATES } from '@gst/domain';
import { isLanguage } from '@gst/i18n';
import {
  buildStoredPrintModel,
  type PrintAccount,
  type PrintBusiness,
  type PrintModel,
  type PrintParty,
} from '@gst/print';

import { getBlob } from '@/app/blobs';
import { readSettings } from '@/features/business/profile';

type Context = Ctx;

interface Address {
  kind?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

/** An address as printed lines: street, then city and pincode. */
export function addressLines(a: Address | null | undefined): string[] {
  if (!a) return [];
  const out = [a.line1, a.line2].map((x) => (x ?? '').trim()).filter(Boolean);
  const place = [a.city, a.pincode]
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join(' ');
  if (place) out.push(place);
  return out;
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** The business logo as a data URL with its size, if it is a PNG or JPEG the PDF writer can embed. */
async function loadLogo(
  database: Database,
  ctx: Context,
  attachmentId: string | undefined,
): Promise<PrintBusiness['logo']> {
  if (!attachmentId) return null;
  try {
    const att = await new AttachmentRepo(database).get(ctx, attachmentId);
    if (!att) return null;
    const mime = String(att['mime'] ?? '');
    if (mime !== 'image/png' && mime !== 'image/jpeg') return null;
    const blob = await getBlob(String(att['storage_path']), mime);
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { dataUrl: await blobToDataUrl(blob), ...size };
  } catch {
    return null;
  }
}

export function printBusiness(row: Row, logo: PrintBusiness['logo']): PrintBusiness {
  const settings = readSettings(row);
  const a = (row['address'] ?? null) as Address | null;
  return {
    name: String(row['trade_name'] ?? row['legal_name'] ?? ''),
    gstin: (row['gstin'] as string | null) ?? null,
    pan: (row['pan'] as string | null) ?? null,
    address: addressLines(a),
    phone: ((settings as { phone?: string }).phone ?? null) || null,
    email: ((settings as { email?: string }).email ?? null) || null,
    scheme: row['scheme'] === 'composition' ? 'composition' : 'regular',
    logo,
  };
}

export function printParty(row: Row): PrintParty {
  const list = (row['addresses_json'] ?? []) as Address[];
  const billing = list.find((x) => x.kind === 'billing') ?? list[0];
  const code = String(row['state_code'] ?? '');
  return {
    name: String(row['name'] ?? ''),
    gstin: (row['gstin'] as string | null) ?? null,
    address: addressLines(billing),
    stateName: code ? `${STATES[code] ?? ''} (${code})`.trim() : null,
    phone: (row['phone'] as string | null) ?? null,
    ...(isLanguage(row['language']) ? { language: row['language'] } : {}),
  };
}

export function printShipTo(row: Row | null): string[] | null {
  if (!row) return null;
  const list = (row['addresses_json'] ?? []) as Address[];
  const ship = list.find((x) => x.kind === 'shipping');
  if (!ship) return null;
  return [String(row['name'] ?? ''), ...addressLines(ship)];
}

export function printAccount(r: Row): PrintAccount {
  return {
    kind: r['kind'],
    name: String(r['name'] ?? ''),
    holder: (r['holder_name'] as string | null) ?? null,
    accountNo: (r['account_no'] as string | null) ?? null,
    ifsc: (r['ifsc'] as string | null) ?? null,
    upiId: (r['upi_id'] as string | null) ?? null,
  };
}

/** What every printed document of this business shares. Loaded once and reused. */
export interface PrintContext {
  business: PrintBusiness;
  accounts: PrintAccount[];
  units: ReadonlyMap<string, string>;
}

export async function loadPrintContext(database: Database, ctx: Context): Promise<PrintContext> {
  const row = await new BusinessRepo(database).get(ctx);
  if (!row) throw new Error('No business is open.');
  const settings = readSettings(row) as { logoAttachmentId?: string };
  const [logo, accounts, units] = await Promise.all([
    loadLogo(database, ctx, settings.logoAttachmentId),
    new BusinessAccountRepo(database).forDocuments(ctx),
    new BaseRepo(database, 'units').list(ctx),
  ]);
  return {
    business: printBusiness(row, logo),
    accounts: accounts.map(printAccount),
    units: new Map(units.map((u) => [String(u['id']), String(u['code'])])),
  };
}

/** The print model of a stored document (issued, cancelled or a draft), the same numbers the editor shows. */
export async function modelForDocument(
  database: Database,
  ctx: Context,
  pc: PrintContext,
  documentId: string,
): Promise<{ model: PrintModel; document: Row } | null> {
  const found = await new DocumentFlowRepo(database).load(ctx, documentId);
  if (!found) return null;
  const doc = found.document;
  const party = doc['party_id'] ? await new PartyRepo(database).get(ctx, doc['party_id']) : null;
  // a stored document prints from its stored amounts, never a recalculation
  const model = buildStoredPrintModel({
    document: doc,
    lines: found.lines,
    business: pc.business,
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
    accounts: pc.accounts,
    units: pc.units,
  });
  return { model, document: doc };
}

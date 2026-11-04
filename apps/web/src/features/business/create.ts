import {
  AttachmentRepo,
  BaseRepo,
  BusinessRepo,
  createOrganisation,
  runInTx,
  type Ctx,
  type Database,
  type Row,
} from '@gst/db';

import { draftToValues, readSettings, type BusinessDraft, type BusinessSettings } from './profile';

import { putBlob, resizeImage, type StoredBlob } from '@/app/blobs';
import { deviceId } from '@/app/store';

export type BrandingKind = 'logo' | 'signature' | 'stamp';
const SETTING_KEY: Record<BrandingKind, keyof BusinessSettings> = {
  logo: 'logoAttachmentId',
  signature: 'signatureAttachmentId',
  stamp: 'stampAttachmentId',
};

/** Resize to at most 512 px, store the bytes by hash and return what to register. */
export async function storeBranding(file: Blob): Promise<StoredBlob> {
  return putBlob(await resizeImage(file, 512));
}

/**
 * Create a business (and the organisation too on first run) with its bank account and images in one
 * transaction. Image bytes are stored first, content-addressed, so a failed transaction leaves at worst an unused file.
 */
export async function createBusiness(
  database: Database,
  draft: BusinessDraft,
  opts: { orgId?: string; logo?: Blob | null } = {},
): Promise<Row> {
  const logo = opts.logo ? await storeBranding(opts.logo) : null;
  const orgId = opts.orgId ?? crypto.randomUUID();
  const ctx0: Ctx = { orgId, businessId: '', actor: 'local-user', deviceId: deviceId() };

  return runInTx(
    database,
    ctx0,
    async (tx) => {
      if (!opts.orgId) {
        await createOrganisation(database, draft.tradeName.trim() || draft.legalName.trim(), {
          id: orgId,
          tx,
        });
      }
      const created = await new BusinessRepo(database).create(
        { ...ctx0, tx },
        draftToValues(draft),
      );
      const ctx: Ctx = { ...ctx0, businessId: created['id'], tx };

      let business = created;
      if (logo) {
        const att = await new AttachmentRepo(database).register(ctx, {
          ownerTable: 'businesses',
          ownerId: created['id'],
          fileName: 'logo.png',
          mime: logo.mime,
          sizeBytes: logo.sizeBytes,
          sha256: logo.sha256,
          storagePath: logo.storagePath,
        });
        business = await new BusinessRepo(database).update(
          ctx,
          { settings_json: { ...readSettings(created), logoAttachmentId: att['id'] } },
          created['version'],
        );
      }

      if (draft.bank.enabled) {
        const b = draft.bank;
        await new BaseRepo(database, 'business_accounts').create(ctx, {
          kind: b.kind,
          name: b.kind === 'upi' ? b.upiId.trim() : b.name.trim(),
          account_no: b.kind === 'bank' ? b.accountNo.trim() : null,
          ifsc: b.kind === 'bank' ? b.ifsc.trim().toUpperCase() : null,
          upi_id: b.kind === 'upi' ? b.upiId.trim() : null,
          is_default: true,
        });
      }
      return business;
    },
    { allowNoBusiness: true },
  );
}

/** Replace the logo, signature or stamp image of an existing business. */
export async function setBranding(
  database: Database,
  ctx: Ctx,
  business: Row,
  kind: BrandingKind,
  file: Blob,
): Promise<Row> {
  const stored = await storeBranding(file);
  return runInTx(database, ctx, async (tx) => {
    const c = { ...ctx, tx };
    const att = await new AttachmentRepo(database).register(c, {
      ownerTable: 'businesses',
      ownerId: business['id'],
      fileName: `${kind}.png`,
      mime: stored.mime,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storagePath: stored.storagePath,
    });
    return new BusinessRepo(database).update(
      c,
      { settings_json: { ...readSettings(business), [SETTING_KEY[kind]]: att['id'] } },
      business['version'],
    );
  });
}

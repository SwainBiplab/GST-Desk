import { AttachmentRepo, BaseRepo, type Ctx, type Database, type Row } from '@gst/db';
import { fyOf } from '@gst/domain';
import { printLabel, shareText, type PrintLabelKey, type PrintLanguage } from '@gst/i18n';
import type { PrintModel } from '@gst/print';

import { putBlob } from '@/app/blobs';

/** Letters, digits, dashes and underscores only, so the name is safe on every file system and in a ZIP. */
export const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}_]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * A file name that is the same every time for the same document: business, financial year, type and
 * number, so saving a document twice replaces rather than piles up.
 */
export function pdfFileName(model: PrintModel, fyStartMonth = 4): string {
  const fy = fyOf(model.date, fyStartMonth).label;
  const type = printLabel('en', `title.${model.type}` as PrintLabelKey);
  const number = model.number ?? 'draft';
  return `${[model.business.name, fy, type, number].map(slug).join('_')}.pdf`;
}

/** The same, for a name pattern: `{type}-{number}` with `{party}`, `{date}`, `{fy}`, `{business}` too. */
export function patternName(pattern: string, model: PrintModel, fyStartMonth = 4): string {
  const vars: Record<string, string> = {
    type: printLabel('en', `title.${model.type}` as PrintLabelKey),
    number: model.number ?? 'draft',
    party: model.party?.name ?? '',
    date: model.date,
    fy: fyOf(model.date, fyStartMonth).label,
    business: model.business.name,
  };
  const name = pattern.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '');
  return `${slug(name) || slug(vars['number']!) || 'document'}.pdf`;
}

export function downloadBytes(name: string, bytes: Uint8Array, mime = 'application/pdf'): void {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Keep the PDF with the document. Saving again replaces the earlier file of the same name, so a
 * document never collects stale copies. Returns the attachment row.
 */
export async function savePdfAttachment(
  database: Database,
  ctx: Ctx,
  documentId: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<Row> {
  const stored = await putBlob(
    new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }),
  );
  const repo = new AttachmentRepo(database);
  const att = new BaseRepo(database, 'attachments');
  const old = (await att.list(ctx)).filter(
    (r) =>
      r['owner_table'] === 'documents' &&
      r['owner_id'] === documentId &&
      r['file_name'] === fileName,
  );
  for (const r of old)
    if (r['sha256'] !== stored.sha256) await att.softDelete(ctx, r['id'], r['version']);
  return repo.register(ctx, {
    ownerTable: 'documents',
    ownerId: documentId,
    fileName,
    mime: 'application/pdf',
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storagePath: stored.storagePath,
  });
}

/** The saved PDF of a document, if one was made. */
export async function findSavedPdf(
  database: Database,
  ctx: Ctx,
  documentId: string,
): Promise<Row | null> {
  const rows = await new BaseRepo(database, 'attachments').list(ctx);
  return (
    rows
      .filter(
        (r) =>
          r['owner_table'] === 'documents' &&
          r['owner_id'] === documentId &&
          r['mime'] === 'application/pdf',
      )
      .sort((a, b) => Number(b['created_at']) - Number(a['created_at']))[0] ?? null
  );
}

export interface ShareArgs {
  model: PrintModel;
  language: PrintLanguage;
  bytes: Uint8Array;
  fileName: string;
  phone: string;
  totalText: string;
  override?: string | null;
}

export type ShareOutcome = 'shared' | 'whatsapp' | 'cancelled';

/**
 * Share a document. Where the device offers a share sheet that accepts files, the PDF goes through it.
 * Elsewhere WhatsApp opens with the message ready and the PDF is saved for attaching: a web page cannot
 * attach a file to a WhatsApp chat on its own.
 */
export async function shareDocument(a: ShareArgs): Promise<ShareOutcome> {
  const text = shareText(
    a.language,
    {
      party: a.model.party?.name ?? '',
      type: printLabel(a.language, `title.${a.model.type}` as PrintLabelKey),
      number: a.model.number ?? '',
      total: a.totalText,
      business: a.model.business.name,
    },
    a.override,
  );
  const file = new File([a.bytes.slice().buffer as ArrayBuffer], a.fileName, {
    type: 'application/pdf',
  });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], text, title: a.fileName });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  downloadBytes(a.fileName, a.bytes);
  const digits = a.phone.replace(/\D/g, '');
  window.open(
    `https://wa.me/${digits ? `91${digits.slice(-10)}` : ''}?text=${encodeURIComponent(text)}`,
    '_blank',
    'noopener',
  );
  return 'whatsapp';
}

/** An email with the message ready (a web page cannot attach the file; the PDF is saved alongside). */
export function emailLink(
  model: PrintModel,
  language: PrintLanguage,
  totalText: string,
  to = '',
): string {
  const subject =
    `${printLabel(language, `title.${model.type}` as PrintLabelKey)} ${model.number ?? ''}`.trim();
  const body = shareText(language, {
    party: model.party?.name ?? '',
    type: printLabel(language, `title.${model.type}` as PrintLabelKey),
    number: model.number ?? '',
    total: totalText,
    business: model.business.name,
  });
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

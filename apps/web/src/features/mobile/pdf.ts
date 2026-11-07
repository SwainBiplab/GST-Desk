/**
 * The PDF of the document on the phone's bill screen (prompt 43): the same template, fonts and engine
 * the editor uses, without the editor's chrome. The file is kept as an attachment of the document, as
 * the desktop does, so it is shared once and found later.
 */
import type { Ctx, Database } from '@gst/db';
import type { BuiltDocument, DraftDocument } from '@gst/domain';
import { formatPaise } from '@gst/ui';
import { useTranslation } from 'react-i18next';

import type { DocMeta } from '../documents/use-editor';
import { pdfFileName, savePdfAttachment, shareDocument } from '../print/actions';
import { familiesFor, loadFonts } from '../print/fonts-client';
import { makePdf } from '../print/pdf-client';
import { modelNow, usePrintContext } from '../print/use-print-model';
import {
  specOf,
  useDefaultTemplateId,
  useTemplates,
  withPartyLanguage,
} from '../print/use-templates';

import { useAppDb } from '@/app/db';
import { useParty } from '@/features/parties/hooks';
import { isNativeApp } from '@/platform';
import { shareFile } from '@/platform/share';

export function useBillPdf(o: {
  draft: DraftDocument;
  built: BuiltDocument;
  meta: DocMeta;
  currentId: () => string | null;
}) {
  const { t } = useTranslation();
  const { database, ctx, business } = useAppDb();
  const templates = useTemplates();
  const templateId = useDefaultTemplateId(o.draft.type, 'shop');
  const printContext = usePrintContext();
  const party = useParty(o.draft.partyId).data ?? null;

  const make = async (over?: { number: string }) => {
    if (!printContext) throw new Error(t('print.notReady'));
    const model = modelNow(printContext, {
      draft: o.draft,
      built: o.built,
      number: over?.number ?? o.meta.number,
      status: over ? 'issued' : o.meta.status,
      revision: o.meta.revision,
      party,
      einvoice: null,
      eway: null,
    });
    const spec = withPartyLanguage(specOf(templates.options, templateId), model.party);
    const fonts = await loadFonts(familiesFor(model, spec));
    const bytes = await makePdf(model, spec, fonts.bytes, {
      title: `${t(`docs.types.${o.draft.type}` as never)} ${model.number ?? ''}`.trim(),
      author: model.business.name,
      created: new Date(`${model.date}T00:00:00Z`),
    });
    const fileName = pdfFileName(model, Number(business?.['fy_start_month'] ?? 4));
    const id = o.currentId();
    if (database && ctx && id && model.number)
      await savePdfAttachment(database as Database, ctx as Ctx, id, fileName, bytes);
    return { model, spec, bytes, fileName };
  };

  /** The share sheet with the PDF: the phone's own, or the browser's with the WhatsApp fallback. */
  const share = async (over?: { number: string }): Promise<'shared' | 'cancelled' | 'fallback'> => {
    const r = await make(over);
    const total = formatPaise(o.built.totals.totalPaise);
    const text = t('mobile.shareText', {
      type: t(`docs.types.${o.draft.type}` as never),
      number: r.model.number ?? '',
      total,
      business: r.model.business.name,
    });
    if (isNativeApp()) {
      const out = await shareFile({
        bytes: r.bytes,
        fileName: r.fileName,
        mime: 'application/pdf',
        text,
        title: r.fileName,
      });
      if (out !== 'unsupported') return out;
    }
    const out = await shareDocument({
      model: r.model,
      language: r.spec.language,
      bytes: r.bytes,
      fileName: r.fileName,
      phone: String(party?.['phone'] ?? ''),
      totalText: total,
    });
    return out === 'shared' ? 'shared' : out === 'cancelled' ? 'cancelled' : 'fallback';
  };

  return { ready: !!printContext, party, make, share };
}

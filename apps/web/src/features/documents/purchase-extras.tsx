import { AttachmentRepo, type Row } from '@gst/db';
import type { DraftDocument } from '@gst/domain';
import { Button, Checkbox, Input, toast } from '@gst/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { checkAttachment } from './files';

import { getBlob, putBlob } from '@/app/blobs';
import { useAppDb } from '@/app/db';
import { Field } from '@/features/onboarding/field';

/** Supplier invoice number and date, and whether the input tax credit can be claimed. */
export function PurchaseFields({
  draft,
  readOnly,
  showIssues,
  onChange,
}: {
  draft: DraftDocument;
  readOnly: boolean;
  showIssues: boolean;
  onChange: (f: (d: DraftDocument) => DraftDocument) => void;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<DraftDocument>) => onChange((d) => ({ ...d, ...patch }));
  return (
    <section
      className="grid gap-4 sm:grid-cols-3"
      aria-label={t('docs.purchase.title')}
      data-testid="purchase-fields"
    >
      <Field
        label={t('docs.purchase.invoiceNo')}
        error={
          showIssues && draft.supplierInvoiceNo.trim() === ''
            ? 'doc_supplier_invoice_no'
            : undefined
        }
      >
        {(c) => (
          <Input
            {...c}
            disabled={readOnly}
            data-testid="supplier-invoice-no"
            value={draft.supplierInvoiceNo}
            onChange={(e) => set({ supplierInvoiceNo: e.target.value })}
          />
        )}
      </Field>
      <Field
        label={t('docs.purchase.invoiceDate')}
        error={showIssues && !draft.supplierInvoiceDate ? 'doc_date' : undefined}
      >
        {(c) => (
          <Input
            {...c}
            type="date"
            disabled={readOnly}
            data-testid="supplier-invoice-date"
            value={draft.supplierInvoiceDate ?? ''}
            onChange={(e) => set({ supplierInvoiceDate: e.target.value || null })}
          />
        )}
      </Field>
      <label className="flex items-center gap-2 self-end pb-2 text-sm" htmlFor="doc-itc">
        <Checkbox
          id="doc-itc"
          data-testid="doc-itc"
          checked={draft.itcEligible}
          disabled={readOnly}
          onCheckedChange={(v) => set({ itcEligible: v === true })}
        />
        {t('docs.purchase.itc')}
      </label>
    </section>
  );
}

interface ShownFile {
  row: Row;
  href: string | null;
}

/**
 * The supplier's bill, next to the entry form. Files are checked by their first bytes (PDF, PNG, JPEG
 * or WebP, at most 10 MB), stored by hash, and registered against the draft.
 */
export function AttachmentPane({
  documentId,
  readOnly,
  ensureSaved,
}: {
  documentId: string | null;
  readOnly: boolean;
  /** Saves the draft so it has an id to attach to. */
  ensureSaved: () => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const [files, setFiles] = useState<ShownFile[]>([]);
  const [current, setCurrent] = useState(0);
  const [busy, setBusy] = useState(false);
  const urls = useRef<string[]>([]);

  // bumped after an upload so the list is read again
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!documentId || !database || !ctx) return;
    let live = true;
    void (async () => {
      const rows = await new AttachmentRepo(database).forOwner(ctx, 'documents', documentId);
      const shown: ShownFile[] = [];
      for (const row of rows) {
        const blob = await getBlob(row['storage_path'], row['mime']);
        shown.push({ row, href: blob ? URL.createObjectURL(blob) : null });
      }
      if (!live) {
        shown.forEach((f) => f.href && URL.revokeObjectURL(f.href));
        return;
      }
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      urls.current = shown.flatMap((f) => (f.href ? [f.href] : []));
      setFiles(shown);
    })();
    return () => {
      live = false;
    };
  }, [documentId, version, database, ctx]);

  // release the object URLs when the pane goes away
  useEffect(
    () => () => {
      urls.current.forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );

  const add = async (file: File) => {
    if (!database || !ctx) return;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const check = checkAttachment(bytes);
      if (!check.ok) {
        toast.error(t(`docs.purchase.file.${check.reason}`, { name: file.name }));
        return;
      }
      const id = await ensureSaved();
      if (!id) return toast.error(t('docs.purchase.file.needsSave'));
      const stored = await putBlob(new Blob([bytes], { type: check.mime }));
      await new AttachmentRepo(database).register(ctx, {
        ownerTable: 'documents',
        ownerId: id,
        fileName: file.name,
        mime: check.mime,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        storagePath: stored.storagePath,
      });
      setVersion((v) => v + 1);
      setCurrent(0);
    } finally {
      setBusy(false);
    }
  };

  const shown = files[current];
  return (
    <div className="flex h-full min-h-64 flex-col gap-2" data-testid="attachment-pane">
      {!readOnly && (
        <input
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          aria-label={t('docs.purchase.attach')}
          data-testid="attachment-input"
          disabled={busy}
          className="text-sm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void add(f);
          }}
        />
      )}
      {files.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {files.map((f, i) => (
            <Button
              key={f.row['id']}
              variant={i === current ? 'primary' : 'outline'}
              className="h-7"
              onClick={() => setCurrent(i)}
            >
              {f.row['file_name']}
            </Button>
          ))}
        </div>
      )}
      {shown?.href ? (
        shown.row['mime'] === 'application/pdf' ? (
          <iframe
            title={shown.row['file_name']}
            src={shown.href}
            data-testid="attachment-view"
            className="min-h-96 w-full flex-1 rounded-md border border-border"
          />
        ) : (
          <img
            src={shown.href}
            alt={shown.row['file_name']}
            data-testid="attachment-view"
            className="max-h-[70vh] w-full rounded-md border border-border object-contain"
          />
        )
      ) : (
        <p className="text-sm text-fg-muted" data-testid="attachment-empty">
          {t('docs.purchase.noAttachment')}
        </p>
      )}
    </div>
  );
}

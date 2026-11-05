import { ItemRepo, ItemValidationError, type Row } from '@gst/db';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  draftToValues,
  emptyItemDraft,
  rowToDraft,
  serverErrorsToForm,
  type Errors,
  type ItemDraft,
} from './form';
import { ItemForm } from './item-form';

import { useAppDb } from '@/app/db';
import { useLocationInfo } from '@/app/hooks';
import { useFeatureFlags } from '@/features/business/hooks';
import { StockPanel } from '@/features/inventory/stock-panel';

/**
 * Create or edit one item: save it, show what the repository rejected (a SKU already in use, a unit
 * from elsewhere) against the right field, and delete when nothing refers to it.
 */
export function ItemEditor({
  existing,
  prefill,
  onDone,
  onCancel,
}: {
  existing?: Row;
  /** Starting values for a new item (quick-create from a document line). */
  prefill?: Partial<ItemDraft>;
  onDone: (saved: Row) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const { shell } = useLocationInfo();
  const flags = useFeatureFlags();
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<Errors | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (draft: ItemDraft) => {
    if (!database || !ctx) return;
    setBusy(true);
    setServerErrors(undefined);
    try {
      const repo = new ItemRepo(database);
      const values = draftToValues(draft);
      let saved: Row;
      if (existing) {
        // opening stock is posted once, when the item is created
        delete values['opening_stock_micros'];
        delete values['opening_stock_value_paise'];
        saved = await repo.update(ctx, existing['id'], values, existing['version']);
      } else {
        saved = await repo.create(ctx, values);
      }
      toast.success(t('items.saved'));
      onDone(saved);
    } catch (e) {
      if (e instanceof ItemValidationError) setServerErrors(serverErrorsToForm(e.fields));
      else toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!database || !ctx || !existing) return;
    setConfirmDelete(false);
    try {
      await new ItemRepo(database).softDelete(ctx, existing['id'], existing['version']);
      toast.success(t('items.deleted'));
      onCancel();
    } catch {
      toast.error(t('items.deleteBlocked'));
    }
  };

  return (
    <>
      <ItemForm
        {...(existing
          ? { initial: rowToDraft(existing) }
          : prefill
            ? { initial: emptyItemDraft(prefill) }
            : {})}
        isEdit={!!existing}
        busy={busy}
        serverErrors={serverErrors}
        onSubmit={save}
        onCancel={onCancel}
        submitLabel={existing ? t('items.form.saveChanges') : t('items.form.save')}
      />
      {existing && flags.inventory && <StockPanel item={existing} shell={shell ?? 'books'} />}
      {existing && (
        <div className="mt-4 border-t border-border pt-3">
          <Button
            type="button"
            variant="ghost"
            className="text-danger"
            data-testid="item-delete"
            onClick={() => setConfirmDelete(true)}
          >
            {t('items.delete')}
          </Button>
        </div>
      )}
      {confirmDelete && (
        <AlertDialog open onOpenChange={(o) => !o && setConfirmDelete(false)}>
          <AlertDialogContent data-testid="item-delete-dialog">
            <AlertDialogTitle className="text-lg font-semibold">
              {t('items.deleteTitle', { name: existing?.['name'] })}
            </AlertDialogTitle>
            <AlertDialogDescription className="py-1 text-fg-muted">
              {t('items.deleteBody')}
            </AlertDialogDescription>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                {t('items.form.cancel')}
              </Button>
              <Button data-testid="item-delete-confirm" onClick={() => void remove()}>
                {t('items.delete')}
              </Button>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

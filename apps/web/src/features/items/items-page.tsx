import { ItemRepo, type BulkBatch } from '@gst/db';
import { PageHeader, Sheet, SheetContent, SheetDescription, SheetTitle, toast } from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useItem } from './hooks';
import { itemImport } from './import-items';
import { ItemEditor } from './item-editor';
import { ItemList } from './item-list';

import { useAppDb } from '@/app/db';
import { useAppNavigate, useLocationInfo } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { ImportWizard } from '@/features/import/import-wizard';

/**
 * The Items page. The URL decides what shows: `?new=1` the create form, `?edit=<id>` the edit form,
 * `?import=1` the CSV import wizard, nothing the list. Books shows forms in a drawer over the list;
 * Shop shows them as a full page.
 */
export function ItemsPage({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const { search } = useLocationInfo();
  const { database, ctx } = useAppDb();
  const editId = typeof search['edit'] === 'string' ? search['edit'] : null;
  const creating = search['new'] === '1' || search['new'] === 1;
  const importing = search['import'] === '1' || search['import'] === 1;
  const editing = useItem(editId);
  const [last, setLast] = useState<BulkBatch | null>(null);

  const toList = () => navigate(`/${shell}/items`);

  const undo = async (batch: BulkBatch) => {
    if (!database || !ctx) return;
    const r = await new ItemRepo(database).undoBulkEdit(ctx, batch);
    setLast(null);
    toast.success(t('items.bulk.undone', { count: r.reverted }));
    if (r.skipped > 0) toast.info(t('items.bulk.undoSkipped', { count: r.skipped }));
  };

  const applied = (batch: BulkBatch, count: number) => {
    setLast(batch);
    toast.success(t('items.bulk.applied', { count }), {
      action: { label: t('items.bulk.undoShort'), onClick: () => void undo(batch) },
    });
  };

  const editor = creating ? (
    <ItemEditor onDone={toList} onCancel={toList} />
  ) : editId && editing.data ? (
    <ItemEditor key={editId} existing={editing.data} onDone={toList} onCancel={toList} />
  ) : null;
  const title = creating ? t('items.form.titleNew') : t('items.form.titleEdit');

  if (editor && shell === 'shop') {
    return (
      <div className="mx-auto max-w-3xl" data-testid="item-page-form">
        <PageHeader title={title} />
        {editor}
      </div>
    );
  }

  return (
    <>
      <ItemList
        shell={shell}
        onApplied={applied}
        lastBatch={last}
        onUndo={() => last && void undo(last)}
      />
      {editor && shell === 'books' && (
        <Sheet open onOpenChange={(o) => !o && toList()}>
          <SheetContent className="w-[min(42rem,100vw)] overflow-auto" data-testid="item-drawer">
            <SheetTitle className="text-lg font-semibold">{title}</SheetTitle>
            <SheetDescription className="pb-3 text-fg-muted">
              {t('items.form.drawerHelp')}
            </SheetDescription>
            {editor}
          </SheetContent>
        </Sheet>
      )}
      {importing && <ImportWizard spec={itemImport} onClose={toList} />}
    </>
  );
}

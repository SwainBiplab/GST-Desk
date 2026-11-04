import { PageHeader, Sheet, SheetContent, SheetDescription, SheetTitle } from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { useParty } from './hooks';
import { Party360 } from './party-360';
import { PartyEditor } from './party-editor';
import { PartyList } from './party-list';

import { useAppNavigate, useLocationInfo } from '@/app/hooks';
import type { Shell } from '@/app/store';

/**
 * The Parties page. The URL decides what shows: `?open=<id>` Party 360, `?new=1` the create form,
 * `?edit=<id>` the edit form, nothing the list. Books shows forms in a drawer over the list; Shop
 * shows them as a full page.
 */
export function PartiesPage({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const { search } = useLocationInfo();
  const openId = typeof search['open'] === 'string' ? search['open'] : null;
  const editId = typeof search['edit'] === 'string' ? search['edit'] : null;
  const creating = search['new'] === '1' || search['new'] === 1;
  const editing = useParty(editId);

  const toList = () => navigate(`/${shell}/parties`);
  const close = () => (editId ? navigate(`/${shell}/parties`, { open: editId }) : toList());

  const editor = creating ? (
    <PartyEditor
      onDone={(p) => navigate(`/${shell}/parties`, { open: p['id'] })}
      onCancel={toList}
    />
  ) : editId && editing.data ? (
    <PartyEditor
      key={editId}
      existing={editing.data}
      onDone={(p) => navigate(`/${shell}/parties`, { open: p['id'] })}
      onCancel={close}
    />
  ) : null;
  const title = creating ? t('parties.form.titleNew') : t('parties.form.titleEdit');

  if (editor && shell === 'shop') {
    return (
      <div className="mx-auto max-w-3xl" data-testid="party-page-form">
        <PageHeader title={title} />
        {editor}
      </div>
    );
  }

  const base = openId ? <Party360 id={openId} shell={shell} /> : <PartyList shell={shell} />;
  return (
    <>
      {base}
      {editor && shell === 'books' && (
        <Sheet open onOpenChange={(o) => !o && close()}>
          <SheetContent className="w-[min(42rem,100vw)] overflow-auto" data-testid="party-drawer">
            <SheetTitle className="text-lg font-semibold">{title}</SheetTitle>
            <SheetDescription className="pb-3 text-fg-muted">
              {t('parties.form.drawerHelp')}
            </SheetDescription>
            {editor}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

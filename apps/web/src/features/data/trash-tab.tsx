import { TrashRepo, type TrashEntry, type TrashTable } from '@gst/db';
import { TRASH_RETENTION_DAYS } from '@gst/domain';
import { Button, Card, CardTitle, EmptyState, toast } from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { useConfirm } from '@/app/components/confirm';
import { useAppDb, useLiveQuery } from '@/app/db';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' });

/** Settings, Trash: what was deleted, for how many more days it stays, and how to bring it back. */
export function TrashTab() {
  const { t } = useTranslation();
  const { database, ctx } = useAppDb();
  const confirm = useConfirm();
  const list = useLiveQuery<TrashEntry[]>({
    tables: ['parties', 'items', 'documents'],
    key: ['trash'],
    fn: (d, c) => new TrashRepo(d).list(c),
  });
  const entries = list.data ?? [];

  const label = (e: TrashEntry) =>
    e.table === 'documents'
      ? `${t(`docs.types.${e.type}`, { defaultValue: e.type })}${e.partyName ? ` · ${e.partyName}` : ''}`
      : e.name;

  const restore = async (e: TrashEntry) => {
    if (!database || !ctx) return;
    try {
      await new TrashRepo(database).restore(ctx, e.table as TrashTable, e.id);
      toast.success(t('data.trash.restored', { name: label(e) }));
    } catch (err) {
      toast.error(errText(err));
    }
  };

  const purge = async (e: TrashEntry) => {
    if (!database || !ctx) return;
    const ok = await confirm({
      title: t('data.trash.purgeTitle', { name: label(e) }),
      description: t('data.trash.purgeBody'),
      confirmLabel: t('data.trash.purge'),
    });
    if (!ok) return;
    try {
      await new TrashRepo(database).purge(ctx, e.table as TrashTable, e.id);
      toast.success(t('data.trash.purged'));
    } catch (err) {
      toast.error(errText(err));
    }
  };

  const empty = async () => {
    if (!database || !ctx) return;
    const ok = await confirm({
      title: t('data.trash.emptyTitle'),
      description: t('data.trash.emptyBody', { count: entries.length }),
      confirmLabel: t('data.trash.empty'),
    });
    if (!ok) return;
    try {
      const n = await new TrashRepo(database).empty(ctx);
      toast.success(t('data.trash.emptied', { count: n }));
    } catch (err) {
      toast.error(errText(err));
    }
  };

  return (
    <div data-testid="section-trash">
      <Card>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>{t('data.trash.title')}</CardTitle>
            <p className="pt-1 text-sm text-fg-muted">
              {t('data.trash.help', { days: TRASH_RETENTION_DAYS })}
            </p>
          </div>
          <Button
            variant="outline"
            data-testid="trash-empty"
            disabled={entries.length === 0}
            onClick={() => void empty()}
          >
            {t('data.trash.empty')}
          </Button>
        </div>
        {entries.length === 0 ? (
          <div data-testid="trash-none">
            <EmptyState title={t('data.trash.none')} description={t('data.trash.noneHint')} />
          </div>
        ) : (
          <table className="mt-3 w-full text-sm" data-testid="trash-list">
            <thead className="text-left text-xs uppercase text-fg-muted">
              <tr>
                <th className="py-1 font-medium">{t('data.trash.what')}</th>
                <th className="py-1 font-medium">{t('data.trash.kind')}</th>
                <th className="py-1 font-medium">{t('data.trash.deleted')}</th>
                <th className="py-1 text-right font-medium">{t('data.trash.daysLeft')}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={`${e.table}:${e.id}`}
                  className="border-t border-border"
                  data-testid="trash-row"
                >
                  <td className="py-1">{label(e)}</td>
                  <td className="py-1">{t(`data.trash.table.${e.table}`)}</td>
                  <td className="py-1">{day(e.deletedAt)}</td>
                  <td className="tabular py-1 text-right" data-testid="trash-days">
                    {t('data.trash.days', { count: e.daysLeft })}
                  </td>
                  <td className="whitespace-nowrap py-1 text-right">
                    <Button
                      variant="ghost"
                      data-testid="trash-restore"
                      onClick={() => void restore(e)}
                    >
                      {t('data.trash.restore')}
                    </Button>
                    <Button
                      variant="ghost"
                      className="text-danger"
                      data-testid="trash-purge"
                      onClick={() => void purge(e)}
                    >
                      {t('data.trash.purge')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/** The inbox card for a sync conflict: the fields that differ, the server's version beside mine. */
import type { SyncConflictItem } from '@gst/ai';
import { useTranslation } from 'react-i18next';

import type { InboxRow } from '../inbox/model';

const HIDDEN = new Set([
  'id',
  'org_id',
  'business_id',
  'version',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
  'metadata_json',
]);

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** The fields I changed that differ from what the server kept. */
export function conflictFields(
  v: Pick<SyncConflictItem, 'mine' | 'theirs'>,
): { field: string; theirs: string; mine: string }[] {
  return Object.keys(v.mine)
    .filter((k) => !HIDDEN.has(k))
    .filter((k) => show(v.mine[k]) !== show(v.theirs[k]))
    .sort()
    .map((k) => ({ field: k, theirs: show(v.theirs[k]), mine: show(v.mine[k]) }));
}

export function SyncConflictDetail({ row }: { row: InboxRow }) {
  const { t } = useTranslation();
  const v = row.suggestion as unknown as SyncConflictItem;
  const fields = conflictFields(v);
  return (
    <div className="py-2" data-testid="sync-conflict-detail">
      <p className="pb-2 text-sm">{v.reason}</p>
      {fields.length > 0 ? (
        <table className="w-full text-sm" data-testid="sync-conflict-fields">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th className="font-normal">{t('sync.conflict.field')}</th>
              <th className="font-normal">{t('sync.conflict.theirs')}</th>
              <th className="font-normal">{t('sync.conflict.mine')}</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.field}>
                <td className="pr-2 text-fg-muted">{f.field}</td>
                <td className="pr-2 break-all">{f.theirs}</td>
                <td className="font-medium break-all">{f.mine}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-fg-muted">{t('sync.conflict.sameFields')}</p>
      )}
      <p className="pt-2 text-xs text-fg-muted">{t('sync.conflict.help')}</p>
    </div>
  );
}

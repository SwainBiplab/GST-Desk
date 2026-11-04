import { useTranslation } from 'react-i18next';

import { diffRows, type AuditEntry } from './audit';

/** What one audit entry changed: field, before and after. */
export function AuditDiff({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation();
  const changes = diffRows(entry.before_json, entry.after_json);
  if (changes.length === 0) return <p className="text-xs text-fg-muted">{t('audit.noChanges')}</p>;
  return (
    <table className="w-full text-left text-xs" data-testid="audit-diff">
      <thead>
        <tr className="text-fg-muted">
          <th className="w-1/4 py-1 pr-2 font-medium">&nbsp;</th>
          <th className="w-[37%] pr-2 font-medium">{t('audit.before')}</th>
          <th className="font-medium">{t('audit.after')}</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={c.field} className="border-t border-border align-top">
            <td className="py-1 pr-2 font-mono">{c.field}</td>
            <td className="break-all pr-2 text-danger">{c.before || '—'}</td>
            <td className="break-all text-success">{c.after || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

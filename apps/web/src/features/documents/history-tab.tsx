import { AuditRepo } from '@gst/db';
import { Button } from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { diffRows, type AuditEntry } from '../numbering/audit';
import { AuditDiff } from '../numbering/audit-diff';

import { useLiveQuery } from '@/app/db';

/**
 * The document's own history: who created, changed, cancelled or revised it and what it was before.
 * Lines, header and any use of the period-lock override are in one list, oldest first.
 */
export function HistoryTab({ documentId, version }: { documentId: string; version: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const { data } = useLiveQuery<AuditEntry[]>({
    tables: ['documents', 'document_lines', 'settings'],
    key: ['history', documentId, version],
    fn: async (d, c) =>
      (await new AuditRepo(d).documentHistory(c, documentId)) as unknown as AuditEntry[],
  });
  const entries = (data ?? []).filter(
    (e) =>
      e.table_name === 'period_lock' ||
      e.action === 'insert' ||
      diffRows(e.before_json, e.after_json).length > 0,
  );
  if (entries.length === 0)
    return (
      <p className="text-sm text-fg-muted" data-testid="history-empty">
        {t('docs.history.empty')}
      </p>
    );

  const lineNo = (e: AuditEntry) =>
    e.table_name === 'document_lines'
      ? Number((e.after_json ?? e.before_json)?.['line_no'] ?? 0)
      : 0;

  return (
    <ol className="flex flex-col gap-2 overflow-auto" data-testid="history-list">
      {entries.map((e) => {
        const shown = open.has(e.id);
        const what =
          e.table_name === 'period_lock'
            ? t('docs.history.override', {
                reason: String(e.after_json?.['override'] ?? ''),
              })
            : e.table_name === 'document_lines'
              ? `${t('docs.history.line', { n: lineNo(e) })} · ${t(`docs.history.${e.action === 'insert' ? 'created' : e.action === 'update' ? 'updated' : 'deleted'}`)}`
              : t(
                  `docs.history.${e.action === 'insert' ? 'created' : e.action === 'update' ? 'updated' : 'deleted'}`,
                );
        const reason =
          e.table_name === 'documents' &&
          e.after_json?.['cancel_reason'] &&
          !e.before_json?.['cancel_reason']
            ? String(e.after_json['cancel_reason'])
            : null;
        return (
          <li
            key={e.id}
            className="rounded-md border border-border p-2 text-sm"
            data-testid="history-entry"
            data-table={e.table_name}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{what}</span>
              <span className="text-xs text-fg-muted">
                {t('docs.history.by', { actor: e.actor })} ·{' '}
                {new Date(e.at).toLocaleString('en-IN')}
              </span>
              {e.table_name !== 'period_lock' && (
                <Button
                  variant="ghost"
                  className="ml-auto"
                  aria-expanded={shown}
                  data-testid="history-toggle"
                  onClick={() =>
                    setOpen((s) => {
                      const n = new Set(s);
                      if (n.has(e.id)) n.delete(e.id);
                      else n.add(e.id);
                      return n;
                    })
                  }
                >
                  {shown ? t('audit.hideChanges') : t('audit.showChanges')}
                </Button>
              )}
            </div>
            {reason && <p className="pt-1 text-xs">{t('docs.cancel.banner', { reason })}</p>}
            {shown && (
              <div className="pt-2">
                <AuditDiff entry={e} />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

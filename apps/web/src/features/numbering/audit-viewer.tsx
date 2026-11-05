import { AuditRepo, DocumentFlowRepo } from '@gst/db';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@gst/ui';
import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { auditCsv, type AuditEntry } from './audit';
import { AuditDiff } from './audit-diff';

import { useLiveQuery } from '@/app/db';
import { downloadText } from '@/features/parties/csv';
import { EXAMPLE } from '@/lib/terms';

const TABLES = [
  'documents',
  'document_lines',
  'parties',
  'items',
  'payments',
  'settings',
  'number_series',
  'period_lock',
  'businesses',
] as const;
const LIMIT = 200;
const LIVE = ['documents', 'document_lines', 'parties', 'items', 'payments', 'settings'];

const dayStart = (iso: string) => Date.parse(`${iso}T00:00:00`);
const dayEnd = (iso: string) => Date.parse(`${iso}T23:59:59.999`);

/** The audit trail: filter by record type, who, dates or a document number; open any entry to see the change. */
export function AuditViewer() {
  const { t } = useTranslation();
  const [table, setTable] = useState('all');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [number, setNumber] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const { data } = useLiveQuery<{ entries: AuditEntry[]; unknownNumber: boolean }>({
    tables: LIVE,
    key: ['audit', table, actor, from, to, number],
    fn: async (d, c) => {
      const audit = new AuditRepo(d);
      if (number.trim()) {
        const docs = await new DocumentFlowRepo(d).findByNumber(c, number.trim());
        if (docs.length === 0) return { entries: [], unknownNumber: true };
        const all = (await Promise.all(docs.map((x) => audit.documentHistory(c, x['id'])))).flat();
        all.sort((a, b) => Number(b['at']) - Number(a['at']));
        return { entries: all as unknown as AuditEntry[], unknownNumber: false };
      }
      const rows = await audit.search(c, {
        ...(table !== 'all' ? { table } : {}),
        ...(actor.trim() ? { actor: actor.trim() } : {}),
        ...(from ? { from: dayStart(from) } : {}),
        ...(to ? { to: dayEnd(to) } : {}),
        limit: LIMIT,
      });
      return { entries: rows as unknown as AuditEntry[], unknownNumber: false };
    },
  });
  const entries = data?.entries ?? [];

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-4" data-testid="audit-viewer">
      <p className="text-sm text-fg-muted">{t('audit.help')}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('audit.table')}
          <Select value={table} onValueChange={setTable}>
            <SelectTrigger data-testid="audit-table">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('audit.allTables')}</SelectItem>
              {TABLES.map((x) => (
                <SelectItem key={x} value={x}>
                  {x.replace(/_/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('audit.actor')}
          <Input
            data-testid="audit-actor"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('audit.from')}
          <Input
            type="date"
            data-testid="audit-from"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('audit.to')}
          <Input
            type="date"
            data-testid="audit-to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('audit.document')}
          <Input
            data-testid="audit-document"
            value={number}
            placeholder={EXAMPLE.documentNumber}
            onChange={(e) => setNumber(e.target.value)}
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          data-testid="audit-export"
          disabled={entries.length === 0}
          onClick={() => downloadText('audit-trail.csv', auditCsv(entries))}
        >
          {t('audit.exportCsv')}
        </Button>
        {entries.length >= LIMIT && !number.trim() && (
          <span className="text-xs text-fg-muted">{t('audit.limit', { n: LIMIT })}</span>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-fg-muted" data-testid="audit-empty">
          {t('audit.empty')}
        </p>
      ) : (
        <table className="w-full text-left text-sm" data-testid="audit-table-rows">
          <thead>
            <tr className="border-b border-border text-fg-muted">
              <th className="py-1 pr-2 font-medium">{t('audit.when')}</th>
              <th className="pr-2 font-medium">{t('audit.actor')}</th>
              <th className="pr-2 font-medium">{t('audit.table')}</th>
              <th className="pr-2 font-medium">{t('audit.record')}</th>
              <th className="pr-2 font-medium">{t('audit.action')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const label =
                (e.after_json?.['number'] as string | undefined) ??
                (e.before_json?.['number'] as string | undefined) ??
                (e.after_json?.['name'] as string | undefined) ??
                (e.before_json?.['name'] as string | undefined) ??
                e.row_id.slice(0, 8);
              const shown = open.has(e.id);
              return (
                <Fragment key={e.id}>
                  <tr
                    className="border-b border-border align-top"
                    data-testid="audit-row"
                    data-table={e.table_name}
                  >
                    <td className="whitespace-nowrap py-1 pr-2 tabular">
                      {new Date(e.at).toLocaleString('en-IN')}
                    </td>
                    <td className="pr-2">{e.actor}</td>
                    <td className="pr-2">{e.table_name.replace(/_/g, ' ')}</td>
                    <td className="pr-2">{label}</td>
                    <td className="pr-2">{t(`audit.${e.action}`)}</td>
                    <td className="text-right">
                      <Button
                        variant="ghost"
                        data-testid="audit-toggle"
                        aria-expanded={shown}
                        onClick={() => toggle(e.id)}
                      >
                        {shown ? t('audit.hideChanges') : t('audit.showChanges')}
                      </Button>
                    </td>
                  </tr>
                  {shown && (
                    <tr>
                      <td colSpan={6} className="bg-surface-1 p-2">
                        <AuditDiff entry={e} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {data?.unknownNumber && (
        <p className="text-sm text-fg-muted" data-testid="audit-unknown-number">
          {t('audit.empty')}
        </p>
      )}
    </div>
  );
}

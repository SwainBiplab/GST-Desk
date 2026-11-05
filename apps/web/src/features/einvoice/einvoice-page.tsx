import { EinvoiceRepo, type Row } from '@gst/db';
import { today } from '@gst/domain';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  MoneyText,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@gst/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { EINV_TABLES, useNow } from './hooks';
import { ewbView, hoursLeft, istText, latestJob } from './model';

import { useAppDb, useLiveQuery } from '@/app/db';
import { useAppNavigate } from '@/app/hooks';
import type { Shell } from '@/app/store';

/** e-Invoices and e-way bills: what is waiting for an IRN (with bulk generation) and the e-way bills. */
export function EinvoicePage({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const now = useNow();
  const { database, ctx } = useAppDb();
  const navigate = useAppNavigate();
  const day = today(() => now);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const data = useLiveQuery({
    tables: [...EINV_TABLES, 'parties'],
    key: ['einv-page'],
    fn: async (d, c) => {
      const repo = new EinvoiceRepo(d);
      const from = `${Number(day.slice(0, 4)) - 1}-04-01`;
      const [on, waiting, jobs, ewbs] = await Promise.all([
        repo.einvoicingOn(c),
        repo.waitingForIrn(c, from, day),
        repo.jobsOf(c, null),
        repo.ewaybillsOf(c, null),
      ]);
      return { on, waiting, jobs, ewbs };
    },
  }).data;

  if (!data) return null;
  const { on, waiting, jobs, ewbs } = data;
  const open = (id: string) => navigate(`/${shell}/documents/${id}` as never);
  const failedOf = (id: string) =>
    latestJob(
      jobs.filter((j) => j['document_id'] === id),
      ['irn'],
    );
  const allPicked = waiting.length > 0 && waiting.every((r) => picked.has(String(r['id'])));
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const generate = async () => {
    if (!database || !ctx) return;
    setBusy(true);
    const out: Record<string, string> = {};
    let queued = 0;
    try {
      const repo = new EinvoiceRepo(database);
      for (const r of waiting) {
        const id = String(r['id']);
        if (!picked.has(id)) continue;
        try {
          const res = await repo.requestIrn(ctx, id, day);
          if (res.problems.length > 0) {
            out[id] = t('einv.waiting.problems', { problem: res.problems[0]!.message });
          } else queued += 1;
        } catch (e) {
          out[id] = e instanceof Error ? e.message : String(e);
        }
      }
      setNotes(out);
      setPicked(new Set(Object.keys(out)));
      if (queued > 0) toast.success(t('einv.waiting.queued', { count: queued }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="einvoice-page">
      <PageHeader title={t('einv.title')} />
      <p className="text-sm text-fg-muted">{t('einv.subtitle')}</p>
      {!on ? (
        <EmptyState title={t('einv.title')} description={t('einv.off')} data-testid="einv-off" />
      ) : (
        <Tabs defaultValue="waiting">
          <TabsList>
            <TabsTrigger value="waiting" data-testid="einv-tab-waiting">
              {t('einv.tabs.waiting')} ({waiting.length})
            </TabsTrigger>
            <TabsTrigger value="ewaybills" data-testid="einv-tab-ewb">
              {t('einv.tabs.ewaybills')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="waiting" className="pt-3">
            {waiting.length === 0 ? (
              <p className="text-sm text-fg-muted" data-testid="waiting-empty">
                {t('einv.waiting.none')}
              </p>
            ) : (
              <>
                <div className="pb-2">
                  <Button
                    data-testid="bulk-generate"
                    disabled={busy || picked.size === 0}
                    onClick={() => void generate()}
                  >
                    {t('einv.waiting.generateAll')} ({picked.size})
                  </Button>
                </div>
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableHeaderCell className="w-8">
                        <Checkbox
                          aria-label={t('einv.waiting.selectAll')}
                          data-testid="select-all"
                          checked={allPicked}
                          onCheckedChange={(v) =>
                            setPicked(v ? new Set(waiting.map((r) => String(r['id']))) : new Set())
                          }
                        />
                      </TableHeaderCell>
                      <TableHeaderCell>{t('einv.ewb.document')}</TableHeaderCell>
                      <TableHeaderCell>
                        {t('docs.list.date', { defaultValue: 'Date' })}
                      </TableHeaderCell>
                      <TableHeaderCell>{t('einv.status.none')}</TableHeaderCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {waiting.map((r) => {
                      const id = String(r['id']);
                      const job = failedOf(id);
                      return (
                        <TableRow key={id} data-testid="waiting-row">
                          <TableCell>
                            <Checkbox
                              aria-label={t('einv.waiting.select', { number: String(r['number']) })}
                              checked={picked.has(id)}
                              onCheckedChange={() => toggle(id)}
                            />
                          </TableCell>
                          <TableCell>
                            <button type="button" className="underline" onClick={() => open(id)}>
                              {String(r['number'])}
                            </button>{' '}
                            <span className="text-fg-muted">{String(r['party_name'] ?? '')}</span>
                          </TableCell>
                          <TableCell>{String(r['date'])}</TableCell>
                          <TableCell className="text-sm">
                            {notes[id] ??
                              (job
                                ? t(`einv.status.${String(job['status'])}` as never, {
                                    defaultValue: String(job['status']),
                                  })
                                : t('einv.status.none'))}
                            <MoneyText paise={Number(r['total_paise'] ?? 0)} className="ml-2" />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </>
            )}
          </TabsContent>

          <TabsContent value="ewaybills" className="pt-3">
            {ewbs.length === 0 ? (
              <p className="text-sm text-fg-muted" data-testid="ewb-empty">
                {t('einv.ewb.empty')}
              </p>
            ) : (
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>{t('einv.ewb.number')}</TableHeaderCell>
                    <TableHeaderCell>{t('einv.ewb.vehicle')}</TableHeaderCell>
                    <TableHeaderCell>{t('einv.ewb.distance')}</TableHeaderCell>
                    <TableHeaderCell>{t('einv.ewb.validUntil', { date: '' })}</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {ewbs.map((w: Row) => {
                    const view = ewbView(w, now);
                    const left = hoursLeft(String(w['valid_until']), now);
                    return (
                      <TableRow key={String(w['id'])} data-testid="ewb-list-row">
                        <TableCell className="font-mono">
                          {w['document_id'] ? (
                            <button
                              type="button"
                              className="underline"
                              onClick={() => open(String(w['document_id']))}
                            >
                              {String(w['ewb_no'])}
                            </button>
                          ) : (
                            String(w['ewb_no'])
                          )}
                        </TableCell>
                        <TableCell>{String(w['vehicle_no'] ?? '')}</TableCell>
                        <TableCell>
                          {t('einv.ewb.distanceUsed', { km: Number(w['distance_km'] ?? 0) })}
                        </TableCell>
                        <TableCell>
                          {istText(String(w['valid_until']))}{' '}
                          <Badge
                            tone={
                              view === 'active'
                                ? left !== null && left < 8
                                  ? 'warning'
                                  : 'success'
                                : view === 'expired'
                                  ? 'danger'
                                  : 'neutral'
                            }
                          >
                            {view === 'cancelled'
                              ? t('einv.ewb.cancelled')
                              : left === null
                                ? t('einv.ewb.expired')
                                : t('einv.ewb.hoursLeft', { count: left })}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

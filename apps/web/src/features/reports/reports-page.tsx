import { REPORTS, REPORT_IDS, type ReportDef } from '@gst/db';
import { Button, Card, CardTitle, PageHeader } from '@gst/ui';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { todayIso } from './hooks';
import { readReportState, writeReportState } from './model';
import { ReportView } from './report-view';

import { useAppDb } from '@/app/db';
import { useAppNavigate, useLocationInfo } from '@/app/hooks';
import type { Shell } from '@/app/store';
import { useFeatureFlags } from '@/features/business/hooks';

const SECTIONS: ReportDef['section'][] = ['registers', 'gst', 'parties', 'money', 'stock'];

/**
 * Reports: the list, and one report at a time. Which report, the period and every filter live in the
 * address (`?report=sales_register&preset=this_month`), so a dashboard number, a saved view and a
 * link all open the same thing.
 */
export function ReportsPage({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const { search } = useLocationInfo();
  const { business } = useAppDb();
  const flags = useFeatureFlags();
  const fyStart = Number(business?.['fy_start_month'] ?? 4);
  const state = useMemo(() => readReportState(search, todayIso(), fyStart), [search, fyStart]);
  const only = typeof search['section'] === 'string' ? search['section'] : null;

  if (state) {
    const title = t(`reports.r.${state.id}.title`);
    return (
      <div className="flex h-full min-h-0 flex-col" data-shell={shell}>
        <PageHeader
          title={title}
          description={t(`reports.r.${state.id}.about`)}
          actions={
            <Button
              variant="ghost"
              data-testid="reports-back"
              onClick={() => navigate(`/${shell}/reports`, only ? { section: only } : {})}
            >
              {t('reports.all')}
            </Button>
          }
        />
        <ReportView key={state.id} state={state} shell={shell} title={title} />
      </div>
    );
  }

  const sections = SECTIONS.filter((s) => !only || s === only);
  return (
    <div data-shell={shell} data-testid="reports-list">
      <PageHeader title={t('nav.reports')} description={t('reports.intro')} />
      <div className="flex flex-col gap-6">
        {sections.map((section) => {
          const ids = REPORT_IDS.filter(
            (id) =>
              REPORTS[id].section === section && (!REPORTS[id].flag || flags[REPORTS[id].flag!]),
          );
          if (ids.length === 0) return null;
          return (
            <section key={section} aria-labelledby={`reports-${section}`}>
              <h2
                id={`reports-${section}`}
                className="pb-2 text-sm font-semibold uppercase text-fg-muted"
              >
                {t(`reports.section.${section}`)}
              </h2>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {ids.map((id) => (
                  <Card key={id} className="flex flex-col gap-1">
                    <CardTitle>{t(`reports.r.${id}.title`)}</CardTitle>
                    <p className="flex-1 text-sm text-fg-muted">{t(`reports.r.${id}.about`)}</p>
                    <div className="pt-2">
                      <Button
                        variant="outline"
                        data-testid={`report-link-${id}`}
                        onClick={() =>
                          navigate(
                            `/${shell}/reports`,
                            writeReportState(readReportState({ report: id }, todayIso(), fyStart)!),
                          )
                        }
                      >
                        {t('reports.open')}
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

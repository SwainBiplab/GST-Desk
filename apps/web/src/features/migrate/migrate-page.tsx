import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { ExportTab } from './export-tab';
import { ImportFlow } from './import-flow';

import type { Shell } from '@/app/store';

/** Move data in from Tally, Vyapar or a spreadsheet, and out to Tally. */
export function MigratePage({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="migrate-page">
      <PageHeader title={t('migrate.title')} description={t('migrate.subtitle')} />
      <p role="note" className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
        {t('migrate.beta')}
      </p>
      <Tabs defaultValue="import">
        <TabsList>
          <TabsTrigger value="import">{t('migrate.tabs.import')}</TabsTrigger>
          <TabsTrigger value="export">{t('migrate.tabs.export')}</TabsTrigger>
        </TabsList>
        <TabsContent value="import">
          <ImportFlow shell={shell} />
        </TabsContent>
        <TabsContent value="export">
          <ExportTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

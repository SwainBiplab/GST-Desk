import {
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@gst/ui';
import { useTranslation } from 'react-i18next';

import { ChallanTab } from './challan-tab';
import { Field } from './common';
import { DeductTab } from './deduct-tab';
import { fyChoices, useFy } from './hooks';
import { IncomeTab } from './income-tab';
import { ReceivableTab } from './receivable-tab';
import { ReturnsTab } from './returns-tab';

import type { Shell } from '@/app/store';

/** TDS, TCS, challans, the quarterly statements, the register of tax customers deducted, and income tax. */
export function DirectTaxPage({ shell }: { shell: Shell }) {
  void shell;
  const { t } = useTranslation();
  const [fy, setFy] = useFy();
  return (
    <div className="flex flex-col gap-4 p-4" data-testid="direct-tax-page">
      <PageHeader
        title={t('directTax.title')}
        description={t('directTax.subtitle')}
        actions={
          <Field label={t('directTax.year')}>
            <Select value={fy} onValueChange={setFy}>
              <SelectTrigger className="w-36" aria-label={t('directTax.year')} data-testid="tax-fy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fyChoices().map((y) => (
                  <SelectItem key={y} value={y}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        }
      />
      <p role="note" className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
        {t('directTax.beta')}
      </p>
      <Tabs defaultValue="tds">
        <TabsList>
          <TabsTrigger value="tds">{t('directTax.tabs.tds')}</TabsTrigger>
          <TabsTrigger value="tcs">{t('directTax.tabs.tcs')}</TabsTrigger>
          <TabsTrigger value="challans">{t('directTax.tabs.challans')}</TabsTrigger>
          <TabsTrigger value="returns">{t('directTax.tabs.returns')}</TabsTrigger>
          <TabsTrigger value="receivable">{t('directTax.tabs.receivable')}</TabsTrigger>
          <TabsTrigger value="income">{t('directTax.tabs.income')}</TabsTrigger>
        </TabsList>
        <TabsContent value="tds">
          <DeductTab fy={fy} kind="tds" />
        </TabsContent>
        <TabsContent value="tcs">
          <DeductTab fy={fy} kind="tcs" />
        </TabsContent>
        <TabsContent value="challans">
          <ChallanTab fy={fy} />
        </TabsContent>
        <TabsContent value="returns">
          <ReturnsTab fy={fy} />
        </TabsContent>
        <TabsContent value="receivable">
          <ReceivableTab fy={fy} />
        </TabsContent>
        <TabsContent value="income">
          <IncomeTab fy={fy} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

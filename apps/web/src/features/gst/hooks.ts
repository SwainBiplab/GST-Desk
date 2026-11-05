import {
  GstrRepo,
  PeriodLockRepo,
  SettingsRepo,
  type BusinessGstInfo,
  type FilingRecord,
} from '@gst/db';
import {
  GSTN_V1,
  type GstrPeriod,
  type PeriodAdjustment,
  type PeriodReview,
  type Return,
} from '@gst/domain';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  gstr1CsvZip,
  gstr1JsonFile,
  gstr3bJsonFile,
  type ExportFile,
  type FilingKind,
} from './model';

import { useAppDb, useLiveQuery } from '@/app/db';
import { downloadBytes } from '@/features/reports/download';

/** Every table a return reads, so it refreshes when any of them is written. */
export const GST_TABLES = [
  'documents',
  'document_lines',
  'parties',
  'units',
  'number_series',
  'gst_adjustments',
  'gst_issue_acks',
  'payment_allocations',
  'hsn_master',
  'settings',
  'businesses',
];

const KIND_KEY = 'gst.filing.kind';

export function useFilingKind(): { kind: FilingKind; set: (k: FilingKind) => Promise<void> } {
  const { database, ctx } = useAppDb();
  const qc = useQueryClient();
  const q = useLiveQuery({
    tables: ['settings'],
    key: ['gst-kind'],
    fn: async (d, c) => (await new SettingsRepo(d).getValue<FilingKind>(c, KIND_KEY)) ?? 'month',
  });
  const set = useCallback(
    async (k: FilingKind) => {
      if (!database || !ctx) return;
      await new SettingsRepo(database).set(ctx, KIND_KEY, k);
      await qc.invalidateQueries();
    },
    [database, ctx, qc],
  );
  return { kind: q.data === 'quarter' ? 'quarter' : 'month', set };
}

export function useBusinessGst(): BusinessGstInfo | undefined {
  return useLiveQuery({
    tables: ['businesses'],
    key: ['gst-business'],
    fn: (d, c) => new GstrRepo(d).businessInfo(c),
  }).data;
}

export function useFilings(): FilingRecord[] {
  return (
    useLiveQuery({
      tables: ['gst_filings'],
      key: ['gst-filings'],
      fn: (d, c) => new GstrRepo(d).listFilings(c),
    }).data ?? []
  );
}

export function useReview(period: GstrPeriod | null, enabled: boolean) {
  return useLiveQuery({
    tables: GST_TABLES,
    key: ['gst-review', period?.fp, period?.kind],
    enabled: enabled && !!period,
    fn: (d, c) => new GstrRepo(d).review(c, period!),
  });
}

export function useAdjustments(fp: string | null) {
  return useLiveQuery({
    tables: ['gst_adjustments'],
    key: ['gst-adjustments', fp],
    enabled: !!fp,
    fn: (d, c) => new GstrRepo(d).listAdjustmentRows(c, fp!),
  });
}

/** The things a person does on a return. Each throws the repository's plain-language message. */
export function useGstActions() {
  const { database, ctx } = useAppDb();
  const need = () => {
    if (!database || !ctx) throw new Error('The database is not ready.');
    return { d: database, c: ctx };
  };

  const exportFiles = useCallback(
    async (ret: Return, review: PeriodReview, which: 'json' | 'csv'): Promise<ExportFile[]> => {
      const { d, c } = need();
      // the period is checked again from the database, so a screen that is out of date cannot export
      const fresh = await new GstrRepo(d).assertExportable(c, review.period);
      const files =
        ret === 'gstr1'
          ? [which === 'json' ? gstr1JsonFile(fresh) : gstr1CsvZip(fresh)]
          : [gstr3bJsonFile(fresh)];
      for (const f of files) downloadBytes(f.name, f.data as BlobPart, f.mime);
      await new GstrRepo(d).markExported(c, ret, review.period, GSTN_V1.version);
      return files;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  const markFiled = useCallback(
    async (
      ret: Return,
      period: GstrPeriod,
      input: { arn: string; filedOn: string },
      lock: boolean,
    ) => {
      const { d, c } = need();
      await new GstrRepo(d).markFiled(c, ret, period, input);
      if (lock)
        await new PeriodLockRepo(d).set(c, period.to, `Filed ${ret.toUpperCase()} ${period.fp}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  const reopen = useCallback(
    async (ret: Return, period: GstrPeriod, reason: string) => {
      const { d, c } = need();
      await new GstrRepo(d).reopen(c, ret, period, reason);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  const addAdjustment = useCallback(
    async (fp: string, adj: PeriodAdjustment) => {
      const { d, c } = need();
      await new GstrRepo(d).addAdjustment(c, fp, adj);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  const removeAdjustment = useCallback(
    async (id: string, version: number) => {
      const { d, c } = need();
      await new GstrRepo(d).removeAdjustment(c, id, version);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  const acknowledge = useCallback(
    async (fp: string, key: string, reason: string) => {
      const { d, c } = need();
      await new GstrRepo(d).acknowledge(c, fp, key, reason);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  const unacknowledge = useCallback(
    async (fp: string, key: string) => {
      const { d, c } = need();
      await new GstrRepo(d).unacknowledge(c, fp, key);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  return {
    exportFiles,
    markFiled,
    reopen,
    addAdjustment,
    removeAdjustment,
    acknowledge,
    unacknowledge,
  };
}

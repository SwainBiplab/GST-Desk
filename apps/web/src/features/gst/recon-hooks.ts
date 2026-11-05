import {
  Gstr2bRepo,
  GstrRepo,
  PartyRepo,
  type DecisionKind,
  type ReconRow,
  type ReconWorkspace,
} from '@gst/db';
import { type GstrPeriod, type PeriodAdjustment, type ReconOptions } from '@gst/domain';
import { useCallback } from 'react';

import { stashPrefill } from './prefill';
import { parseReturnFile } from './recon-file';

import { useAppDb, useLiveQuery } from '@/app/db';

/** Every table the reconciliation reads, so it refreshes when any of them is written. */
export const RECON_TABLES = [
  'documents',
  'parties',
  'gstr2b_entries',
  'gstr2b_imports',
  'gstr2b_decisions',
];

export function useReconOptions() {
  return useLiveQuery<ReconOptions>({
    tables: ['settings'],
    key: ['gst-recon-options'],
    fn: (d, c) => new Gstr2bRepo(d).options(c),
  });
}

export function useWorkspace(period: GstrPeriod | null) {
  return useLiveQuery<ReconWorkspace>({
    tables: [...RECON_TABLES, 'settings'],
    key: ['gst-recon', period?.fp, period?.kind],
    enabled: !!period,
    fn: (d, c) => new Gstr2bRepo(d).workspace(c, period!),
  });
}

/** The things a person does on a reconciliation. Each throws the repository's plain-language message. */
export function useReconActions(period: GstrPeriod) {
  const { database, ctx } = useAppDb();
  const need = () => {
    if (!database || !ctx) throw new Error('The database is not ready.');
    return { d: database, c: ctx };
  };

  const importFile = useCallback(
    async (file: File, month: string) => {
      const { d, c } = need();
      const info = await new GstrRepo(d).businessInfo(c);
      const { parsed, source, hash } = await parseReturnFile(file, month, info.gstin);
      return new Gstr2bRepo(d).importReturn(c, parsed, {
        source,
        ...(hash ? { fileHash: hash } : {}),
        ...(source === 'xlsx' ? { period: month } : {}),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  const acceptAll = useCallback(
    async () => {
      const { d, c } = need();
      return new Gstr2bRepo(d).acceptMatches(c, period);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx, period],
  );

  const decide = useCallback(
    async (
      row: ReconRow,
      decision: DecisionKind,
      opts: { linkedDocumentId?: string; note?: string } = {},
    ) => {
      const { d, c } = need();
      await new Gstr2bRepo(d).decide(c, period.fp, row.decisionRef, decision, opts);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx, period],
  );

  const clear = useCallback(
    async (row: ReconRow) => {
      const { d, c } = need();
      await new Gstr2bRepo(d).clearDecision(c, row.decisionRef);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  const apply = useCallback(
    async (): Promise<PeriodAdjustment[]> => {
      const { d, c } = need();
      return new Gstr2bRepo(d).applyOutcomes(c, period);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx, period],
  );

  /**
   * Make sure the supplier exists as a party (adding them if not), and leave the 2B line for the editor,
   * which opens a purchase bill from it. Returns the supplier's name and whether they were just added.
   */
  const prepareBill = useCallback(
    async (row: ReconRow) => {
      const { d, c } = need();
      const e = row.entry;
      if (!e) throw new Error('This row has no GSTR-2B line to start a bill from.');
      const parties = new PartyRepo(d);
      let party = (await parties.findByGstin(c, e.supplierGstin))[0];
      let added = false;
      if (!party) {
        party = await parties.create(c, {
          type: 'supplier',
          name: e.supplierName || e.supplierGstin,
          gstin: e.supplierGstin,
          state_code: e.supplierGstin.slice(0, 2),
        });
        added = true;
      }
      stashPrefill({
        party: {
          id: String(party['id']),
          name: String(party['name']),
          gstin: e.supplierGstin,
          state_code: String(party['state_code'] ?? e.supplierGstin.slice(0, 2)),
        },
        number: e.number,
        date: e.date,
        taxable: e.taxable,
        igst: e.igst,
        cgst: e.cgst,
        sgst: e.sgst,
        cess: e.cess,
      });
      return { name: String(party['name']), added };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  const saveOptions = useCallback(
    async (o: ReconOptions) => {
      const { d, c } = need();
      return new Gstr2bRepo(d).setOptions(c, o);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [database, ctx],
  );

  return { importFile, acceptAll, decide, clear, apply, prepareBill, saveOptions };
}

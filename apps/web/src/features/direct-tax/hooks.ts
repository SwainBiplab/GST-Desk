import { BaseRepo, DirectTaxRepo, PartyRepo, SettingsRepo, type Proposal, type Row } from '@gst/db';
import {
  fyOfDate,
  quartersOfFy,
  today,
  type ChallanRecord,
  type DeductionRecord,
  type ReceivableRow,
} from '@gst/domain';
import { useCallback, useState } from 'react';

import { useAppDb, useLiveQuery } from '@/app/db';

/** Every table the pages here read, so they refresh when any of them is written. */
export const TAX_TABLES = [
  'tax_deductions',
  'tax_challans',
  'tds_receivable',
  'documents',
  'parties',
];

export const currentFy = (): string => fyOfDate(today(() => new Date()));

/** The financial years to pick from: this one and the four before it. */
export function fyChoices(): string[] {
  const start = Number(currentFy().slice(0, 4));
  return [0, 1, 2, 3, 4].map((i) => {
    const y = start - i;
    return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  });
}

export function useFy(): [string, (fy: string) => void] {
  return useState(currentFy);
}

export const useDeductions = (fy: string) =>
  useLiveQuery<DeductionRecord[]>({
    tables: TAX_TABLES,
    key: ['deductions', fy],
    fn: (d, c) => new DirectTaxRepo(d).deductions(c, fy),
  });

export const useChallans = (fy: string) =>
  useLiveQuery<ChallanRecord[]>({
    tables: TAX_TABLES,
    key: ['challans', fy],
    fn: (d, c) => new DirectTaxRepo(d).challans(c, fy),
  });

export const useProposals = (fy: string, kind: 'tds' | 'tcs') =>
  useLiveQuery<Proposal[]>({
    tables: TAX_TABLES,
    key: ['proposals', fy, kind],
    fn: (d, c) => new DirectTaxRepo(d).proposals(c, fy, kind),
  });

export const useReceivables = (fy: string) =>
  useLiveQuery<ReceivableRow[]>({
    tables: TAX_TABLES,
    key: ['receivables', fy],
    fn: (d, c) => new DirectTaxRepo(d).receivables(c, fy),
  });

/** Every live party, for the pickers. */
export const usePartyChoices = () =>
  useLiveQuery<Row[]>({
    tables: ['parties'],
    key: ['tax-parties'],
    fn: (d, c) => new PartyRepo(d).list(c, { orderBy: d.schema.parties.name }),
  });

/** The things a person does here. Each throws the repository's plain-language message. */
export function useTaxActions() {
  const { database, ctx } = useAppDb();
  const need = () => {
    if (!database || !ctx) throw new Error('The database is not ready.');
    return { d: database, c: ctx };
  };
  const repo = () => new DirectTaxRepo(need().d);
  /** A row's version is needed to remove it, so it is read back first. */
  const versionOf = async (table: string, id: string): Promise<number> => {
    const { d, c } = need();
    const row = await new BaseRepo(d, table as never).get(c, id);
    if (!row) throw new Error('That entry was not found.');
    return Number(row['version']);
  };
  return {
    record: (p: Parameters<DirectTaxRepo['record']>[1]) => repo().record(need().c, p),
    preview: (m: Parameters<DirectTaxRepo['preview']>[1]) => repo().preview(need().c, m),
    remove: async (id: string) =>
      repo().removeDeduction(need().c, id, await versionOf('tax_deductions', id)),
    addChallan: (x: Parameters<DirectTaxRepo['addChallan']>[1]) => repo().addChallan(need().c, x),
    removeChallan: async (id: string) =>
      repo().removeChallan(need().c, id, await versionOf('tax_challans', id)),
    mapToChallan: (ids: string[], challanId: string | null) =>
      repo().mapToChallan(need().c, ids, challanId),
    addReceivable: (r: Parameters<DirectTaxRepo['addReceivable']>[1]) =>
      repo().addReceivable(need().c, r),
    setReceivableStatus: (
      id: string,
      status: Parameters<DirectTaxRepo['setReceivableStatus']>[2],
      cert?: { no: string; date: string },
    ) => repo().setReceivableStatus(need().c, id, status, cert),
    removeReceivable: async (id: string) =>
      repo().removeReceivable(need().c, id, await versionOf('tds_receivable', id)),
  };
}

/** What a person typed into the income-tax form, kept per business and year. */
export interface IncomeForm {
  age: 'below60' | 'senior' | 'super_senior';
  method: 'books' | '44AD' | '44ADA';
  netProfit: string;
  turnover: string;
  receipts: string;
  digitalPct: string;
  cashPct: string;
  other: string;
  d80c: string;
  d80ccd: string;
  d80dSelf: string;
  d80dParents: string;
  parentsSenior: boolean;
  homeLoan: string;
  dOther: string;
  credit: string;
  advance: { date: string; amount: string }[];
  filing: string;
}

export const emptyIncomeForm = (): IncomeForm => ({
  age: 'below60',
  method: 'books',
  netProfit: '',
  turnover: '',
  receipts: '',
  digitalPct: '100',
  cashPct: '0',
  other: '',
  d80c: '',
  d80ccd: '',
  d80dSelf: '',
  d80dParents: '',
  parentsSenior: false,
  homeLoan: '',
  dOther: '',
  credit: '',
  advance: [],
  filing: '',
});

const key = (fy: string) => `incometax.${fy}`;

export function useIncomeForm(fy: string) {
  const { database, ctx } = useAppDb();
  const q = useLiveQuery<IncomeForm | null>({
    tables: ['settings'],
    key: ['income-form', fy],
    fn: async (d, c) => (await new SettingsRepo(d).getValue<IncomeForm>(c, key(fy))) ?? null,
  });
  const save = useCallback(
    async (f: IncomeForm) => {
      if (!database || !ctx) return;
      await new SettingsRepo(database).set(ctx, key(fy), f);
    },
    [database, ctx, fy],
  );
  return { saved: q.data ?? null, loaded: q.isSuccess, save };
}

/** From the books: net profit and turnover of a year, to fill the form. */
export function useBooksFigures(fy: string) {
  return useLiveQuery<{ profit: bigint; turnover: bigint }>({
    tables: ['ledger_entries', 'documents'],
    key: ['books-figures', fy],
    fn: async (d, c) => {
      const start = Number(fy.slice(0, 4));
      const from = `${start}-04-01`;
      const to = `${start + 1}-03-31`;
      const repo = new DirectTaxRepo(d);
      return {
        profit: await repo.profitFromBooks(c, from, to),
        turnover: await repo.turnover(c, from, to),
      };
    },
  });
}

export const quarterChoices = (fy: string) => quartersOfFy(fy);

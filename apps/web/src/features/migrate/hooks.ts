import { InteropRepo, SettingsRepo, type BookImportPlan, type BookImportResult } from '@gst/db';
import { today } from '@gst/domain';
import {
  DEFAULT_TALLY_NAMES,
  buildTallyMasters,
  buildTallyVouchers,
  type ImportBundle,
  type TallyExportInput,
  type TallyExportResult,
  type TallyNames,
} from '@gst/interop';

import { useAppDb, useLiveQuery } from '@/app/db';

const NAMES_KEY = 'tally.names';
const LOG_KEY = 'migrations';

export interface MigrationRecord {
  at: string;
  source: string;
  fileName: string;
  parties: number;
  items: number;
  documents: number;
  payments: number;
  skipped: number;
  problems: number;
}

export function useTallyNames() {
  const { database, ctx } = useAppDb();
  const q = useLiveQuery<Partial<TallyNames> | null>({
    tables: ['settings'],
    key: ['tally-names'],
    fn: async (d, c) =>
      (await new SettingsRepo(d).getValue<Partial<TallyNames>>(c, NAMES_KEY)) ?? null,
  });
  return {
    names: { ...DEFAULT_TALLY_NAMES, ...(q.data ?? {}) },
    save: async (n: Partial<TallyNames>) => {
      if (database && ctx) await new SettingsRepo(database).set(ctx, NAMES_KEY, n);
    },
  };
}

export const useMigrationLog = () =>
  useLiveQuery<MigrationRecord[]>({
    tables: ['settings'],
    key: ['migration-log'],
    fn: async (d, c) => (await new SettingsRepo(d).getValue<MigrationRecord[]>(c, LOG_KEY)) ?? [],
  });

/** What a person does on this page. Each throws the repository's plain-language message. */
export function useMigrateActions() {
  const { database, ctx } = useAppDb();
  const need = () => {
    if (!database || !ctx) throw new Error('The database is not ready.');
    return { d: database, c: ctx };
  };
  return {
    plan: (bundle: ImportBundle): Promise<BookImportPlan> => {
      const { d, c } = need();
      return new InteropRepo(d).plan(c, bundle);
    },
    apply: async (bundle: ImportBundle, fileName: string): Promise<BookImportResult> => {
      const { d, c } = need();
      const result = await new InteropRepo(d).apply(c, bundle);
      // a record for support: what was brought in, from what, and how many things needed a look
      const settings = new SettingsRepo(d);
      const log = (await settings.getValue<MigrationRecord[]>(c, LOG_KEY)) ?? [];
      log.push({
        at: new Date().toISOString(),
        source: bundle.source,
        fileName,
        parties: result.parties,
        items: result.items,
        documents: result.documents,
        payments: result.payments,
        skipped: result.skipped,
        problems: result.issues.filter((i) => i.severity !== 'info').length,
      });
      await settings.set(c, LOG_KEY, log.slice(-50));
      return result;
    },
    tallyFiles: async (
      from: string,
      to: string,
      names: Partial<TallyNames>,
      what: { masters: boolean; vouchers: boolean },
    ): Promise<{
      masters: TallyExportResult | null;
      vouchers: TallyExportResult | null;
      input: TallyExportInput;
    }> => {
      const { d, c } = need();
      const input = { ...(await new InteropRepo(d).tallyInput(c, from, to)), names };
      return {
        input,
        masters: what.masters ? buildTallyMasters(input) : null,
        vouchers: what.vouchers ? buildTallyVouchers(input) : null,
      };
    },
  };
}

export const today10 = (): string => today(() => new Date());

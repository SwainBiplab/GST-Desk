import { EinvoiceRepo, GstrRepo, type GspConfig, type Row } from '@gst/db';
import { useEffect, useState } from 'react';

import { useLiveQuery } from '@/app/db';

/** Every table these screens read, so they refresh when the queue writes. */
export const EINV_TABLES = ['einvoices', 'ewaybills', 'gsp_jobs', 'documents', 'settings'];

export interface DocPortal {
  on: boolean;
  cfg: GspConfig;
  einv: Row | null;
  jobs: Row[];
  ewbs: Row[];
}

/** The e-invoice and e-way bill state of one document. */
export function useDocPortal(documentId: string | null): DocPortal | undefined {
  return useLiveQuery({
    tables: EINV_TABLES,
    key: ['einv-doc', documentId],
    enabled: !!documentId,
    fn: async (d, c) => {
      const repo = new EinvoiceRepo(d);
      const [on, cfg, einv, jobs, ewbs] = await Promise.all([
        repo.einvoicingOn(c),
        repo.gspConfig(c),
        repo.einvoiceOf(c, documentId!),
        repo.jobsOf(c, documentId!),
        repo.ewaybillsOf(c, documentId!),
      ]);
      return { on, cfg, einv, jobs, ewbs };
    },
  }).data;
}

export interface PortalSettings {
  on: boolean;
  cfg: GspConfig;
  hasCredentials: boolean;
  /** Last financial year's turnover from these books, in paise. */
  turnoverPaise: number;
}

export function usePortalSettings(today: string): PortalSettings | undefined {
  return useLiveQuery({
    tables: ['settings', 'documents', 'businesses'],
    key: ['einv-settings', today],
    fn: async (d, c) => {
      const repo = new EinvoiceRepo(d);
      const gstr = new GstrRepo(d);
      const info = await gstr.businessInfo(c);
      const [on, cfg, sealed, turnoverPaise] = await Promise.all([
        repo.einvoicingOn(c),
        repo.gspConfig(c),
        repo.sealedCredentials(c),
        gstr.priorYearTurnover(c, {
          gstin: info.gstin,
          fp: '',
          from: today,
          to: today,
          kind: 'month',
        }),
      ]);
      return { on, cfg, hasCredentials: !!sealed, turnoverPaise };
    },
  }).data;
}

/** The time now, ticking once a minute (for validity countdowns and the 24-hour windows). */
export function useNow(everyMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

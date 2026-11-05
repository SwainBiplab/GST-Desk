import type { Row } from '@gst/db';
import type { BuiltDocument, DraftDocument } from '@gst/domain';
import { buildPrintModel, type PrintInput, type PrintModel } from '@gst/print';
import { useEffect, useMemo, useState } from 'react';

import { loadPrintContext, printParty, printShipTo, type PrintContext } from './model';

import { useLiveQuery } from '@/app/db';

/** Business details, accounts and units, kept current as they change. */
export function usePrintContext(): PrintContext | null {
  const q = useLiveQuery<PrintContext>({
    tables: ['businesses', 'business_accounts', 'attachments', 'units'],
    key: ['print-context'],
    fn: (d, c) => loadPrintContext(d, c),
  });
  return q.data ?? null;
}

/** A value that follows `value` once it has been still for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

export interface PrintModelInput {
  draft: DraftDocument;
  built: BuiltDocument;
  number: string | null;
  status: 'draft' | 'issued' | 'cancelled';
  revision: number;
  party: Row | null;
  /** The recorded IRN and QR, when the document has been e-invoiced. */
  einvoice?: PrintInput['einvoice'];
  /** The active e-way bill number. */
  eway?: string | null;
}

/**
 * The print model of the document being edited, from the same draft and engine result the grid shows,
 * 150 ms after the last change. `null` until the business details have loaded.
 */
export function usePrintModel(input: PrintModelInput, delayMs = 150): PrintModel | null {
  const pc = usePrintContext();
  const shown = useDebounced(input, delayMs);
  return useMemo(() => (pc ? modelNow(pc, shown) : null), [pc, shown]);
}

/** The print model for exactly these values, now (not debounced): what a PDF or a share is made from. */
export function modelNow(pc: PrintContext, input: PrintModelInput): PrintModel {
  const { draft, built, number, status, revision, party, einvoice, eway } = input;
  return buildPrintModel({
    draft,
    built,
    number,
    status,
    revision,
    business: pc.business,
    party: party
      ? printParty(party)
      : draft.partyName
        ? {
            name: draft.partyName,
            gstin: draft.partyGstin,
            address: [],
            stateName: null,
            phone: null,
          }
        : null,
    shipTo: printShipTo(party),
    accounts: pc.accounts,
    units: pc.units,
    einvoice: einvoice ?? null,
    eway: eway ?? null,
  });
}

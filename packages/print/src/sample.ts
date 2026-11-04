/**
 * A sample document built by the real engine: what the template designer previews while you design, and
 * what the tests print. Nothing here is special-cased; it is an ordinary invoice.
 */
import {
  buildDocument,
  emptyDraft,
  emptyDraftLine,
  type DocumentType,
  type DraftDocument,
} from '@gst/domain';

import { buildPrintModel, type PrintAccount, type PrintBusiness, type PrintModel } from './model';

export const BANK: PrintAccount = {
  kind: 'bank',
  name: 'HDFC Current',
  holder: 'Demo Traders',
  accountNo: '50100123456789',
  ifsc: 'HDFC0001234',
  upiId: null,
};
export const UPI: PrintAccount = {
  kind: 'upi',
  name: 'Shop UPI',
  holder: null,
  accountNo: null,
  ifsc: null,
  upiId: 'demo@okhdfc',
};

export interface DocOptions {
  type?: DocumentType;
  lines?: number;
  pos?: string;
  status?: 'draft' | 'issued' | 'cancelled';
  composition?: boolean;
  export?: boolean;
  reverseCharge?: boolean;
  notes?: string;
  terms?: string;
  accounts?: PrintAccount[];
  gstRateBp?: number;
  /** Use this business (the designer previews with the real one). */
  business?: PrintBusiness;
}

/** A printable model of an invoice with `lines` lines, built by the real engine. */
export function samplePrintModel(o: DocOptions = {}): PrintModel {
  const type = o.type ?? 'tax_invoice';
  const base = emptyDraft(type, '2026-05-01', {
    supplierState: '27',
    ...(o.composition ? { composition: true } : {}),
  });
  const draft: DraftDocument = {
    ...base,
    placeOfSupply: o.export ? '96' : (o.pos ?? '27'),
    export: !!o.export,
    lut: !!o.export,
    reverseCharge: !!o.reverseCharge,
    partyName: 'Sharma Stores',
    notes: o.notes ?? '',
    terms:
      o.terms ??
      '<p>Goods once sold will not be taken back.</p><ul><li>Interest at 18% on late payment</li></ul>',
    lines: Array.from({ length: o.lines ?? 3 }, (_, i) => ({
      ...emptyDraftLine(`k${i}`),
      description: `Widget number ${i + 1} with a reasonably long description that wraps`,
      hsn: '7318',
      qtyMicros: 2_000_000n,
      ratePaise: 50_000n + BigInt(i) * 100n,
      gstRateBp: o.gstRateBp ?? 1800,
    })),
  };
  const built = buildDocument(draft);
  return buildPrintModel({
    draft,
    built,
    number: o.status === 'draft' ? null : 'INV/26-27/0001',
    status: o.status ?? 'issued',
    business: o.business ?? {
      name: 'Demo Traders Pvt Ltd',
      gstin: '27AABCD1234E1Z5',
      pan: 'AABCD1234E',
      address: ['12 Market Road', 'Andheri East, Mumbai 400069'],
      phone: '9800000000',
      email: 'accounts@demo.example',
      scheme: o.composition ? 'composition' : 'regular',
      logo: null,
    },
    party: {
      name: 'Sharma Stores',
      gstin: '27AAAPA1234A1Z5',
      address: ['4 Station Lane', 'Pune 411001'],
      stateName: 'Maharashtra',
      phone: '9811111111',
    },
    accounts: o.accounts ?? [BANK, UPI],
    units: new Map(),
  });
}

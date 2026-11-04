import {
  buildDocument,
  emptyDraft,
  emptyDraftLine,
  type DocumentType,
  type DraftDocument,
} from '@gst/domain';

import type { Item, LayoutPage } from '../src/layout';
import { buildPrintModel, type PrintAccount, type PrintModel } from '../src/model';

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
}

/** A printable model of an invoice with `lines` lines, built by the real engine. */
export function sampleModel(o: DocOptions = {}): PrintModel {
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
    business: {
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

export const texts = (p: LayoutPage): string[] =>
  p.items.filter((i): i is Extract<Item, { t: 'text' }> => i.t === 'text').map((i) => i.text);

export const allTexts = (pages: LayoutPage[]): string[] => pages.flatMap(texts);

export const textItems = (p: LayoutPage) =>
  p.items.filter((i): i is Extract<Item, { t: 'text' }> => i.t === 'text');

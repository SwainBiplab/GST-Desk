import { PartyRepo } from '@gst/db';
import {
  PARTY_FIELDS,
  STATES,
  parseAmountPaise,
  parseScaledStrict,
  readRow,
  today,
  toDecimalString,
} from '@gst/domain';

import type { ImportInput, ImportProblem, ImportReview, ImportSpec } from '../import/types';

import { draftToValues, emptyPartyDraft, validateParty, type PartyDraft } from './form';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

const STATE_LOOKUP = new Map<string, string>(
  Object.entries(STATES).flatMap(([code, name]) => [
    [norm(code), code],
    [norm(name), code],
  ]),
);

export const PARTIES_TEMPLATE = [
  'Name,Trade Name,Type,GSTIN,Phone,Email,Address,City,State,Pincode,Credit Days,Opening Balance,Tags',
  'Sharma Traders,,customer,,9876543210,sharma@example.com,12 MG Road,Pune,Maharashtra,411001,30,5000,wholesale',
].join('\r\n');

const TYPES: Record<string, PartyDraft['type']> = {
  customer: 'customer',
  customers: 'customer',
  buyer: 'customer',
  supplier: 'supplier',
  suppliers: 'supplier',
  vendor: 'supplier',
  vendors: 'supplier',
  both: 'both',
};

/**
 * One mapped file row as a party draft. A negative opening balance (or one in brackets) means the
 * business owes the party. A balance with no date is dated today.
 */
export function partyDraftFromRow(r: Record<string, string>): {
  draft: PartyDraft;
  problems: ImportProblem[];
} {
  const problems: ImportProblem[] = [];
  const bad = (field: string, code: string) => problems.push({ field, code });
  const draft = emptyPartyDraft();
  draft.name = r['name']!;
  draft.tradeName = r['trade_name']!;
  draft.gstin = r['gstin']!.replace(/\s+/g, '').toUpperCase();
  draft.phone = r['phone']!;
  draft.email = r['email']!;
  draft.billing = { line1: r['address']!, city: r['city']!, pincode: r['pincode']! };
  draft.tags = r['tags']!;

  if (r['type']) {
    const t = TYPES[norm(r['type'])];
    if (t) draft.type = t;
    else bad('type', 'party_type');
  }
  if (r['state']) {
    const code = STATE_LOOKUP.get(norm(r['state']));
    if (code) draft.stateCode = code;
    else bad('state', 'state_unknown');
  }
  if (r['credit_days']) {
    const days = parseScaledStrict(r['credit_days'], 0);
    if (days === null || days === undefined) bad('credit_days', 'creditDays');
    else draft.creditDays = String(days);
  }
  if (r['opening_balance']) {
    const paise = parseAmountPaise(r['opening_balance'], { allowNegative: true });
    if (paise === null || paise === undefined) bad('opening_balance', 'amount');
    else if (paise !== 0) {
      draft.opening = toDecimalString(BigInt(Math.abs(paise)));
      draft.openingSide = paise < 0 ? 'we-owe' : 'they-owe';
      draft.openingDate = today(() => new Date());
    }
  }
  return { draft, problems };
}

const ERROR_FIELD: Record<string, string> = { stateCode: 'state', billingPincode: 'pincode' };

/** Check every row of a party file, including GSTIN clashes inside the file and with stored parties. */
export async function reviewPartyRows(input: ImportInput): Promise<ImportReview> {
  const { database, ctx } = input;
  const existing = await new PartyRepo(database).listLite(ctx);
  const gstins = new Set(existing.map((p) => p.gstin).filter((g): g is string => !!g));
  const review: ImportReview = { total: input.rows.length, valid: [], invalid: [] };

  input.rows.forEach((raw, i) => {
    const line = input.lines[i]!;
    const { draft, problems } = partyDraftFromRow(readRow(raw, input.mapping));
    for (const [field, code] of Object.entries(validateParty(draft, 'full'))) {
      if (code) problems.push({ field: ERROR_FIELD[field] ?? field, code });
    }
    if (draft.gstin && gstins.has(draft.gstin) && !problems.some((p) => p.field === 'gstin'))
      problems.push({ field: 'gstin', code: 'duplicate_gstin' });
    if (problems.length > 0) {
      review.invalid.push({ line, problems, raw });
      return;
    }
    if (draft.gstin) gstins.add(draft.gstin);
    review.valid.push({ line, values: draftToValues(draft), raw });
  });
  return review;
}

export const partyImport: ImportSpec = {
  entity: 'parties',
  fields: PARTY_FIELDS,
  review: reviewPartyRows,
  async commit({ values, database, ctx, onProgress, shouldCancel }) {
    const r = await new PartyRepo(database).bulkCreate(ctx, values, { onProgress, shouldCancel });
    return r.created;
  },
  template: PARTIES_TEMPLATE,
  templateName: 'parties-template.csv',
};

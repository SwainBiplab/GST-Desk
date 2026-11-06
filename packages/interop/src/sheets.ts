/**
 * Parties and items from spreadsheet rows, and a guess at what a sheet holds. The column mapping is the
 * one parties and items already use (`PARTY_FIELDS`, `ITEM_FIELDS`), so a mapping chosen for the CSV import
 * means the same here. A row that cannot be read is a problem with its line number, never a silent zero.
 */
import {
  ITEM_FIELDS,
  PARTY_FIELDS,
  STATES,
  detectMapping,
  parseAmountPaise,
  parseRateBp,
  readRow,
  type Mapping,
} from '@gst/domain';

import { DOCUMENT_FIELDS, detectDocumentMapping } from './documents';
import type { ImportIssue, ImportItem, ImportParty } from './types';

const STATE_BY_NAME = new Map(Object.entries(STATES).map(([c, n]) => [n.toLowerCase(), c]));
const stateCode = (t: string): string => {
  const v = t.trim();
  if (/^\d{2}$/.test(v)) return v;
  return STATE_BY_NAME.get(v.toLowerCase()) ?? '';
};

const blank = (r: Record<string, string>): boolean =>
  Object.values(r).every((v) => (v ?? '').trim() === '');

export function detectPartyMapping(headers: readonly string[]): Mapping {
  return detectMapping(headers, PARTY_FIELDS);
}
export function detectItemMapping(headers: readonly string[]): Mapping {
  return detectMapping(headers, ITEM_FIELDS);
}

export interface RowsInput {
  rows: readonly (readonly string[])[];
  lines: readonly number[];
  mapping: Mapping;
}

export function partiesFromRows(input: RowsInput): {
  parties: ImportParty[];
  issues: ImportIssue[];
} {
  const issues: ImportIssue[] = [];
  const parties: ImportParty[] = [];
  input.rows.forEach((cells, i) => {
    const line = input.lines[i] ?? i + 2;
    const r = readRow(cells, input.mapping);
    if (blank(r)) return;
    const get = (k: string) => (r[k] ?? '').trim();
    const name = get('name');
    if (!name) {
      issues.push({ severity: 'error', ref: `line ${line}`, message: 'no party name' });
      return;
    }
    const gstin = get('gstin').toUpperCase();
    if (gstin && !/^\d{2}[A-Z0-9]{13}$/.test(gstin))
      issues.push({
        severity: 'warning',
        ref: `line ${line}`,
        message: `${name}: "${gstin}" is not a GSTIN; it is left out`,
      });
    const good = /^\d{2}[A-Z0-9]{13}$/.test(gstin) ? gstin : '';
    let opening = 0n;
    if (get('opening_balance') !== '') {
      const v = parseAmountPaise(get('opening_balance'), { allowNegative: true });
      if (v === null || v === undefined)
        issues.push({
          severity: 'warning',
          ref: `line ${line}`,
          message: `${name}: "${get('opening_balance')}" is not an amount; the opening balance is left out`,
        });
      else opening = BigInt(v);
    }
    const t = get('type').toLowerCase();
    parties.push({
      name,
      type: /supplier|vendor|creditor|purchase/.test(t)
        ? 'supplier'
        : /both/.test(t)
          ? 'both'
          : 'customer',
      gstin: good,
      pan: good ? good.slice(2, 12) : '',
      stateCode: good ? good.slice(0, 2) : stateCode(get('state')),
      phone: get('phone')
        .replace(/[\s()-]/g, '')
        .replace(/^(\+?91|0)(?=\d{10}$)/, ''),
      email: get('email'),
      addressLine: get('address'),
      city: get('city'),
      pincode: get('pincode'),
      openingBalancePaise: opening,
      country: 'India',
    });
  });
  return { parties, issues };
}

export function itemsFromRows(input: RowsInput): { items: ImportItem[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const items: ImportItem[] = [];
  input.rows.forEach((cells, i) => {
    const line = input.lines[i] ?? i + 2;
    const r = readRow(cells, input.mapping);
    if (blank(r)) return;
    const get = (k: string) => (r[k] ?? '').trim();
    const name = get('name');
    if (!name) {
      issues.push({ severity: 'error', ref: `line ${line}`, message: 'no item name' });
      return;
    }
    const money = (k: string): bigint => {
      if (get(k) === '') return 0n;
      const v = parseAmountPaise(get(k));
      if (v === null || v === undefined) {
        issues.push({
          severity: 'warning',
          ref: `line ${line}`,
          message: `${name}: "${get(k)}" is not an amount; it is left out`,
        });
        return 0n;
      }
      return BigInt(v);
    };
    let gst: number | null = null;
    if (get('gst_rate') !== '') {
      const bp = parseRateBp(get('gst_rate'));
      if (bp === null || bp === undefined)
        issues.push({
          severity: 'warning',
          ref: `line ${line}`,
          message: `${name}: "${get('gst_rate')}" is not a tax rate; it is left out`,
        });
      else gst = bp;
    }
    items.push({
      name,
      sku: get('sku'),
      hsn: get('hsn'),
      unit: get('unit'),
      gstRateBp: gst,
      sellPaise: money('sale_price'),
      buyPaise: money('purchase_price'),
      kind: /service/i.test(get('kind')) || get('hsn').startsWith('99') ? 'service' : 'goods',
    });
  });
  return { items, issues };
}

export type SheetKind = 'parties' | 'items' | 'documents' | 'unknown';

/** What a sheet most likely holds, from its headings. */
export function classifySheet(headers: readonly string[]): {
  kind: SheetKind;
  score: Record<Exclude<SheetKind, 'unknown'>, number>;
} {
  const count = (m: Mapping, keys: string[]) =>
    keys.filter((k) => m[k] !== null && m[k] !== undefined).length;
  const docM = detectDocumentMapping(headers);
  const partyM = detectPartyMapping(headers);
  const itemM = detectItemMapping(headers);
  const score = {
    documents:
      docM['number'] !== null && docM['date'] !== null
        ? 2 +
          count(
            docM,
            DOCUMENT_FIELDS.map((f) => f.key),
          )
        : 0,
    parties:
      partyM['name'] !== null
        ? count(partyM, [
            'gstin',
            'phone',
            'email',
            'city',
            'state',
            'address',
            'opening_balance',
            'pincode',
          ])
        : 0,
    items:
      itemM['name'] !== null
        ? count(itemM, [
            'hsn',
            'sale_price',
            'purchase_price',
            'gst_rate',
            'unit',
            'sku',
            'opening_qty',
          ])
        : 0,
  };
  const best = (Object.entries(score) as [Exclude<SheetKind, 'unknown'>, number][]).sort(
    (a, b) => b[1] - a[1],
  )[0]!;
  return { kind: best[1] >= 2 ? best[0] : 'unknown', score };
}

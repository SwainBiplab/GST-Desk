/**
 * Party form model: the draft, validation (pure and unit-tested) and the mapping to the `parties` row.
 * "quick" mode is the short form used inline from the invoice grid: name, GSTIN or state, phone.
 */
import type { Row } from '@gst/db';
import { PAN, STATES, checkGstin, parseGstin } from '@gst/domain';

export type PartyType = 'customer' | 'supplier' | 'both';
export type FormMode = 'full' | 'quick';

export interface AddressDraft {
  line1: string;
  city: string;
  pincode: string;
}

export interface ContactDraft {
  name: string;
  phone: string;
  email: string;
}

export interface PartyDraft {
  type: PartyType;
  name: string;
  /** The Roman-letter form of the name, kept when it is typed in a native script, for search. */
  nameLatin: string;
  /** The language of this party's documents and reminders; empty means the business default. */
  language: string;
  tradeName: string;
  gstin: string;
  stateCode: string;
  country: string;
  isSez: boolean;
  isComposition: boolean;
  phone: string;
  email: string;
  billing: AddressDraft;
  shippingSame: boolean;
  shipping: AddressDraft;
  contacts: ContactDraft[];
  creditDays: string;
  /** Rupees as typed; empty means none. */
  creditLimit: string;
  /** Rupees as typed. */
  opening: string;
  openingSide: 'they-owe' | 'we-owe';
  /** ISO date or empty. */
  openingDate: string;
  notes: string;
  /** Comma separated. */
  tags: string;
  /** PAN typed in, for a party with no GSTIN (a valid GSTIN gives its own PAN). */
  pan: string;
  deducteeType: '' | 'company' | 'non_company';
  /** The TDS section to deduct under when we pay this party; empty means none. */
  tdsSection: string;
  tdsCategory: '' | 'individual_huf' | 'other';
  tdsKind: '' | 'professional' | 'technical';
  /** What we collect TCS on when we sell to this party; empty means nothing. */
  tcsNature: string;
  lowerCertNo: string;
  /** A percentage as typed. */
  lowerCertRate: string;
  lowerCertFrom: string;
  lowerCertTo: string;
  /** Rupees as typed. */
  lowerCertLimit: string;
}

const blankAddress = (): AddressDraft => ({ line1: '', city: '', pincode: '' });

export const emptyPartyDraft = (type: PartyType = 'customer'): PartyDraft => ({
  type,
  name: '',
  nameLatin: '',
  language: '',
  tradeName: '',
  gstin: '',
  stateCode: '',
  country: 'India',
  isSez: false,
  isComposition: false,
  phone: '',
  email: '',
  billing: blankAddress(),
  shippingSame: true,
  shipping: blankAddress(),
  contacts: [],
  creditDays: '0',
  creditLimit: '',
  opening: '',
  openingSide: 'they-owe',
  openingDate: '',
  notes: '',
  tags: '',
  pan: '',
  deducteeType: '',
  tdsSection: '',
  tdsCategory: '',
  tdsKind: '',
  tcsNature: '',
  lowerCertNo: '',
  lowerCertRate: '',
  lowerCertFrom: '',
  lowerCertTo: '',
  lowerCertLimit: '',
});

export type Errors = Partial<Record<string, string>>;

const PHONE = /^[6-9]\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normalisePhone = (raw: string) =>
  raw.replace(/[\s()-]/g, '').replace(/^(\+?91|0)(?=\d{10}$)/, '');

export const isExport = (d: Pick<PartyDraft, 'country'>) =>
  d.country.trim().toLowerCase() !== 'india' && d.country.trim() !== '';

/** State, PAN and entity read from the GSTIN, when it is valid. */
export function deriveParty(d: Pick<PartyDraft, 'gstin'>) {
  const r = parseGstin(d.gstin);
  return r.ok ? r.details : null;
}

/** "12.50" -> 1250. Returns null for empty, NaN for garbage. */
export function rupeesToPaise(text: string): number | null {
  const t = text.replace(/[₹,\s]/g, '');
  if (t === '') return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return Number.NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

export function validateParty(d: PartyDraft, mode: FormMode = 'full'): Errors {
  const e: Errors = {};
  if (d.name.trim().length < 2) e['name'] = 'name';

  const exporting = isExport(d);
  if (d.gstin.trim()) {
    const c = checkGstin(d.gstin);
    if (!c.valid) e['gstin'] = `gstin_${c.reason}`;
  } else if (!exporting && !d.stateCode) {
    e['stateCode'] = 'stateRequired';
  }
  if (d.country.trim() === '') e['country'] = 'country';

  if (d.phone.trim() && !PHONE.test(normalisePhone(d.phone))) e['phone'] = 'phone';
  if (mode === 'quick') return e;

  if (d.email.trim() && !EMAIL.test(d.email.trim())) e['email'] = 'email';
  for (const [key, a] of [
    ['billing', d.billing],
    ['shipping', d.shipping],
  ] as const) {
    if (key === 'shipping' && d.shippingSame) continue;
    if (a.pincode.trim() && !/^\d{6}$/.test(a.pincode.trim())) e[`${key}Pincode`] = 'pincode';
  }
  d.contacts.forEach((c, i) => {
    if (c.phone.trim() && !PHONE.test(normalisePhone(c.phone))) e[`contact${i}Phone`] = 'phone';
    if (c.email.trim() && !EMAIL.test(c.email.trim())) e[`contact${i}Email`] = 'email';
  });
  const days = Number(d.creditDays);
  if (!Number.isInteger(days) || days < 0 || days > 3650) e['creditDays'] = 'creditDays';
  const limit = rupeesToPaise(d.creditLimit);
  if (limit !== null && (Number.isNaN(limit) || limit < 0)) e['creditLimit'] = 'amount';
  const opening = rupeesToPaise(d.opening);
  if (opening !== null && Number.isNaN(opening)) e['opening'] = 'amount';
  if (d.openingDate && !/^\d{4}-\d{2}-\d{2}$/.test(d.openingDate)) e['openingDate'] = 'date';
  if (d.pan.trim() && !PAN.test(d.pan.trim().toUpperCase())) e['pan'] = 'pan';
  const hasCert = [d.lowerCertNo, d.lowerCertRate, d.lowerCertFrom, d.lowerCertTo].some((x) =>
    x.trim(),
  );
  if (hasCert) {
    const rate = Number(d.lowerCertRate);
    if (d.lowerCertRate.trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 100)
      e['lowerCertRate'] = 'certRate';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.lowerCertFrom)) e['lowerCertFrom'] = 'date';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.lowerCertTo)) e['lowerCertTo'] = 'date';
    else if (d.lowerCertFrom && d.lowerCertTo < d.lowerCertFrom) e['lowerCertTo'] = 'certDates';
    const lim = rupeesToPaise(d.lowerCertLimit);
    if (lim !== null && (Number.isNaN(lim) || lim < 0)) e['lowerCertLimit'] = 'amount';
  }
  return e;
}

/** Values for `PartyRepo.create` / `update`. */
export function draftToValues(d: PartyDraft): Record<string, unknown> {
  const derived = deriveParty(d);
  const exporting = isExport(d);
  const stateCode = derived?.stateCode ?? (exporting ? '96' : d.stateCode);
  const opening = rupeesToPaise(d.opening) ?? 0;
  const limit = rupeesToPaise(d.creditLimit) ?? 0;
  const billing = { kind: 'billing', ...trimAddress(d.billing) };
  const shipping = d.shippingSame ? null : { kind: 'shipping', ...trimAddress(d.shipping) };
  return {
    type: d.type,
    name: d.name.trim(),
    name_latin: d.nameLatin.trim() || null,
    language: d.language || null,
    trade_name: d.tradeName.trim() || null,
    gstin: derived?.gstin ?? null,
    pan: derived?.pan ?? (d.pan.trim() ? d.pan.trim().toUpperCase() : null),
    state_code: stateCode || null,
    country: d.country.trim() || 'India',
    phone: d.phone.trim() ? normalisePhone(d.phone) : null,
    email: d.email.trim() || null,
    city: d.billing.city.trim() || null,
    addresses_json: [billing, ...(shipping ? [shipping] : [])].filter(
      (a) => a.line1 || a.city || a.pincode,
    ),
    contacts_json: d.contacts.filter((c) => c.name.trim() || c.phone.trim() || c.email.trim()),
    credit_days: Number(d.creditDays) || 0,
    credit_limit_paise: limit,
    opening_balance_paise: d.openingSide === 'we-owe' ? -opening : opening,
    opening_balance_date: opening !== 0 ? d.openingDate || null : null,
    notes: d.notes.trim() || null,
    tags_json: parseTags(d.tags),
    is_sez: !!derived && d.isSez,
    is_export: exporting,
    is_unregistered: !derived,
    is_composition: !!derived && d.isComposition,
    deductee_type: d.deducteeType || null,
    tds_section: d.tdsSection || null,
    tds_category: d.tdsSection === '194C' ? d.tdsCategory || null : null,
    tds_kind: d.tdsSection === '194J' ? d.tdsKind || null : null,
    tcs_nature: d.tcsNature || null,
    lower_cert_no: d.lowerCertNo.trim() || null,
    lower_cert_rate_bp: d.lowerCertRate.trim() ? Math.round(Number(d.lowerCertRate) * 100) : null,
    lower_cert_from: d.lowerCertFrom || null,
    lower_cert_to: d.lowerCertTo || null,
    lower_cert_limit_paise: d.lowerCertLimit.trim()
      ? (rupeesToPaise(d.lowerCertLimit) ?? null)
      : null,
  };
}

const trimAddress = (a: AddressDraft) => ({
  line1: a.line1.trim(),
  city: a.city.trim(),
  pincode: a.pincode.trim(),
});

/** Rebuild an editable draft from a stored party. */
export function rowToDraft(row: Row): PartyDraft {
  const addresses = (row['addresses_json'] ?? []) as (AddressDraft & { kind?: string })[];
  const billing = addresses.find((a) => a.kind === 'billing') ?? addresses[0] ?? blankAddress();
  const shipping = addresses.find((a) => a.kind === 'shipping');
  const opening = Number(row['opening_balance_paise'] ?? 0);
  const limit = Number(row['credit_limit_paise'] ?? 0);
  return {
    ...emptyPartyDraft(row['type']),
    type: row['type'],
    name: row['name'] ?? '',
    nameLatin: row['name_latin'] ?? '',
    language: row['language'] ?? '',
    tradeName: row['trade_name'] ?? '',
    gstin: row['gstin'] ?? '',
    stateCode: row['state_code'] ?? '',
    country: row['country'] ?? 'India',
    isSez: !!row['is_sez'],
    isComposition: !!row['is_composition'],
    phone: row['phone'] ?? '',
    email: row['email'] ?? '',
    billing: {
      line1: billing.line1 ?? '',
      city: billing.city ?? row['city'] ?? '',
      pincode: billing.pincode ?? '',
    },
    shippingSame: !shipping,
    shipping: shipping
      ? { line1: shipping.line1 ?? '', city: shipping.city ?? '', pincode: shipping.pincode ?? '' }
      : blankAddress(),
    contacts: ((row['contacts_json'] ?? []) as ContactDraft[]).map((c) => ({
      name: c.name ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
    })),
    creditDays: String(row['credit_days'] ?? 0),
    creditLimit: limit ? (limit / 100).toFixed(2) : '',
    opening: opening ? (Math.abs(opening) / 100).toFixed(2) : '',
    openingSide: opening < 0 ? 'we-owe' : 'they-owe',
    openingDate: row['opening_balance_date'] ?? '',
    notes: row['notes'] ?? '',
    tags: ((row['tags_json'] ?? []) as string[]).join(', '),
    pan: row['gstin'] ? '' : (row['pan'] ?? ''),
    deducteeType: row['deductee_type'] ?? '',
    tdsSection: row['tds_section'] ?? '',
    tdsCategory: row['tds_category'] ?? '',
    tdsKind: row['tds_kind'] ?? '',
    tcsNature: row['tcs_nature'] ?? '',
    lowerCertNo: row['lower_cert_no'] ?? '',
    lowerCertRate:
      row['lower_cert_rate_bp'] == null ? '' : String(Number(row['lower_cert_rate_bp']) / 100),
    lowerCertFrom: row['lower_cert_from'] ?? '',
    lowerCertTo: row['lower_cert_to'] ?? '',
    lowerCertLimit: row['lower_cert_limit_paise']
      ? (Number(row['lower_cert_limit_paise']) / 100).toFixed(2)
      : '',
  };
}

export const stateName = (code: string | null | undefined) => (code ? (STATES[code] ?? code) : '');

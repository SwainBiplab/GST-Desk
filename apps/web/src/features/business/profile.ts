/**
 * Business profile: the draft edited by the wizard and Settings, its validation (pure, so it is
 * unit-tested), and the mapping to and from the `businesses` row.
 */
import type { Row } from '@gst/db';
import {
  PRESETS,
  STATES,
  checkGstin,
  parseGstin,
  type DocumentType,
  type FeatureFlags,
  type PresetId,
} from '@gst/domain';

import type { Shell } from '@/app/store';

export interface BankDraft {
  enabled: boolean;
  kind: 'bank' | 'upi';
  name: string;
  accountNo: string;
  ifsc: string;
  upiId: string;
}

export interface BusinessDraft {
  language: string;
  shell: Shell;
  start: 'blank' | 'sample' | 'import';
  gstin: string;
  notRegistered: boolean;
  stateCode: string;
  composition: boolean;
  legalName: string;
  tradeName: string;
  line1: string;
  city: string;
  pincode: string;
  phone: string;
  email: string;
  preset: PresetId;
  bank: BankDraft;
}

export const emptyDraft = (): BusinessDraft => ({
  language: 'en',
  shell: 'shop',
  start: 'blank',
  gstin: '',
  notRegistered: false,
  stateCode: '',
  composition: false,
  legalName: '',
  tradeName: '',
  line1: '',
  city: '',
  pincode: '',
  phone: '',
  email: '',
  preset: 'trader',
  bank: { enabled: false, kind: 'bank', name: '', accountNo: '', ifsc: '', upiId: '' },
});

/** Error keys (resolved with `t()` as `val.<key>`), by field. */
export type Errors = Partial<Record<string, string>>;

/** Registered businesses derive state and PAN from the GSTIN; others pick a state. */
export function deriveFromGstin(d: Pick<BusinessDraft, 'gstin' | 'notRegistered'>) {
  if (d.notRegistered) return null;
  const r = parseGstin(d.gstin);
  return r.ok ? r.details : null;
}

export function validateRegistration(d: BusinessDraft): Errors {
  const e: Errors = {};
  if (d.notRegistered) {
    if (!d.stateCode || !Object.hasOwn(STATES, d.stateCode)) e['stateCode'] = 'stateRequired';
    return e;
  }
  if (!d.gstin.trim()) {
    e['gstin'] = 'gstinRequired';
    return e;
  }
  const c = checkGstin(d.gstin);
  if (!c.valid) e['gstin'] = `gstin_${c.reason}`;
  return e;
}

const PHONE = /^[6-9]\d{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Phone digits without country code or separators, or the input unchanged if it is not a phone number. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[\s()-]/g, '').replace(/^(\+?91|0)(?=\d{10}$)/, '');
  return digits;
}

export function validateDetails(d: BusinessDraft): Errors {
  const e: Errors = {};
  if (d.legalName.trim().length < 2) e['legalName'] = 'nameRequired';
  if (!d.line1.trim()) e['line1'] = 'addressRequired';
  if (d.pincode.trim() && !/^\d{6}$/.test(d.pincode.trim())) e['pincode'] = 'pincode';
  if (d.phone.trim() && !PHONE.test(normalisePhone(d.phone))) e['phone'] = 'phone';
  if (d.email.trim() && !EMAIL.test(d.email.trim())) e['email'] = 'email';
  return e;
}

export function validateBank(b: BankDraft): Errors {
  const e: Errors = {};
  if (!b.enabled) return e;
  if (b.kind === 'upi') {
    if (!/^[\w.-]{2,}@[a-z][a-z0-9]{1,}$/i.test(b.upiId.trim())) e['upiId'] = 'upi';
    return e;
  }
  if (!b.name.trim()) e['bankName'] = 'bankName';
  if (!/^\d{9,18}$/.test(b.accountNo.trim())) e['accountNo'] = 'accountNo';
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(b.ifsc.trim().toUpperCase())) e['ifsc'] = 'ifsc';
  return e;
}

export interface BusinessSettings {
  contact?: { phone?: string; email?: string };
  notRegisteredYet?: boolean;
  logoAttachmentId?: string;
  signatureAttachmentId?: string;
  stampAttachmentId?: string;
  overrides?: Partial<FeatureFlags>;
  terms?: Partial<Record<DocumentType, string>>;
  units?: string[];
  printTemplate?: string;
  documentTypes?: DocumentType[];
  language?: string;
}

export const readSettings = (row: Row | null | undefined): BusinessSettings =>
  (row?.['settings_json'] as BusinessSettings | null | undefined) ?? {};

export interface BusinessAddress {
  line1?: string;
  city?: string;
  pincode?: string;
  stateCode?: string;
}

export const readAddress = (row: Row | null | undefined): BusinessAddress =>
  (row?.['address'] as BusinessAddress | null | undefined) ?? {};

/** Values for `BusinessRepo.create` / `update`. */
export function draftToValues(d: BusinessDraft): Record<string, unknown> {
  const derived = deriveFromGstin(d);
  const stateCode = derived?.stateCode ?? d.stateCode;
  const preset = PRESETS[d.preset];
  const settings: BusinessSettings = {
    contact: {
      ...(d.phone.trim() ? { phone: normalisePhone(d.phone) } : {}),
      ...(d.email.trim() ? { email: d.email.trim() } : {}),
    },
    ...(d.notRegistered ? { notRegisteredYet: true } : {}),
    units: preset.units,
    printTemplate: preset.printTemplate,
    documentTypes: preset.documentTypes,
    language: d.language,
  };
  return {
    gstin: derived?.gstin ?? null,
    legal_name: d.legalName.trim(),
    trade_name: d.tradeName.trim() || null,
    address: {
      line1: d.line1.trim(),
      ...(d.city.trim() ? { city: d.city.trim() } : {}),
      ...(d.pincode.trim() ? { pincode: d.pincode.trim() } : {}),
      stateCode,
    },
    state_code: stateCode,
    pan: derived?.pan ?? null,
    scheme: d.composition && !d.notRegistered ? 'composition' : 'regular',
    fy_start_month: 4,
    preset: d.preset,
    settings_json: settings,
  };
}

/** Rebuild an editable draft from a stored business. */
export function rowToDraft(row: Row): BusinessDraft {
  const a = readAddress(row);
  const s = readSettings(row);
  return {
    ...emptyDraft(),
    language: s.language ?? 'en',
    gstin: row['gstin'] ?? '',
    notRegistered: !row['gstin'],
    stateCode: row['state_code'] ?? '',
    composition: row['scheme'] === 'composition',
    legalName: row['legal_name'] ?? '',
    tradeName: row['trade_name'] ?? '',
    line1: a.line1 ?? '',
    city: a.city ?? '',
    pincode: a.pincode ?? '',
    phone: s.contact?.phone ?? '',
    email: s.contact?.email ?? '',
    preset: (row['preset'] as PresetId | null) ?? 'trader',
  };
}

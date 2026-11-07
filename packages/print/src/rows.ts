/**
 * Rows of the shared schema as the print model's pieces (business, party, bank accounts, ship-to). Pure, so
 * the browser, the desktop and the cloud API (which renders the PDF it sends) read rows the same way.
 */
import { STATES } from '@gst/domain';
import { isLanguage } from '@gst/i18n';

import type { PrintAccount, PrintBusiness, PrintParty } from './model';

// Rows come untyped from the repositories; the mappers read each field defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface Address {
  kind?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

/** An address as printed lines: street, then city and pincode. */
export function addressLines(a: Address | null | undefined): string[] {
  if (!a) return [];
  const out = [a.line1, a.line2].map((x) => (x ?? '').trim()).filter(Boolean);
  const place = [a.city, a.pincode]
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join(' ');
  if (place) out.push(place);
  return out;
}

export function printBusiness(row: Row, logo: PrintBusiness['logo']): PrintBusiness {
  const settings = (row['settings_json'] ?? {}) as { phone?: string; email?: string };
  const a = (row['address'] ?? null) as Address | null;
  return {
    name: String(row['trade_name'] ?? row['legal_name'] ?? ''),
    gstin: (row['gstin'] as string | null) ?? null,
    pan: (row['pan'] as string | null) ?? null,
    address: addressLines(a),
    phone: (settings.phone ?? null) || null,
    email: (settings.email ?? null) || null,
    scheme: row['scheme'] === 'composition' ? 'composition' : 'regular',
    logo,
  };
}

export function printParty(row: Row): PrintParty {
  const list = (row['addresses_json'] ?? []) as Address[];
  const billing = list.find((x) => x.kind === 'billing') ?? list[0];
  const code = String(row['state_code'] ?? '');
  return {
    name: String(row['name'] ?? ''),
    gstin: (row['gstin'] as string | null) ?? null,
    address: addressLines(billing),
    stateName: code ? `${STATES[code] ?? ''} (${code})`.trim() : null,
    phone: (row['phone'] as string | null) ?? null,
    ...(isLanguage(row['language']) ? { language: row['language'] } : {}),
  };
}

export function printShipTo(row: Row | null): string[] | null {
  if (!row) return null;
  const list = (row['addresses_json'] ?? []) as Address[];
  const ship = list.find((x) => x.kind === 'shipping');
  if (!ship) return null;
  return [String(row['name'] ?? ''), ...addressLines(ship)];
}

export function printAccount(r: Row): PrintAccount {
  return {
    kind: r['kind'],
    name: String(r['name'] ?? ''),
    holder: (r['holder_name'] as string | null) ?? null,
    accountNo: (r['account_no'] as string | null) ?? null,
    ifsc: (r['ifsc'] as string | null) ?? null,
    upiId: (r['upi_id'] as string | null) ?? null,
  };
}

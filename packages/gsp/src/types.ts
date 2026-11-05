/**
 * The GSP adapter: everything GST Desk asks of a GST Suvidha Provider. A vendor is one implementation of
 * this interface; nothing else in the app knows which vendor is in use.
 */
import type { IrnResult } from '@gst/domain';

/** The credentials for one GSTIN. Held encrypted on the device; never logged. */
export interface GspCredentials {
  gstin: string;
  /** The GSP's own client id and secret, when the vendor needs them. */
  clientId?: string;
  clientSecret?: string;
  /** API user created on the e-invoice portal. */
  einvUser?: string;
  einvPassword?: string;
  /** API user created on the e-way bill portal. */
  ewbUser?: string;
  ewbPassword?: string;
}

export type Portal = 'einvoice' | 'ewaybill';

export interface GspSession {
  portal: Portal;
  gstin: string;
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface EwbResult {
  ewbNo: string;
  /** ISO time (IST offset) the portal recorded. */
  generatedAt: string;
  validUntil: string;
  /** The distance the portal used (it works it out when we send 0). */
  distanceKm: number;
}

export interface EwbStatus extends EwbResult {
  status: 'active' | 'cancelled';
  vehicleNo: string | null;
}

export interface GspAdapter {
  readonly name: string;
  /** Sandbox or production: a sandbox never files anything real. */
  readonly sandbox: boolean;
  authenticate(creds: GspCredentials, portal: Portal): Promise<GspSession>;

  generateIrn(s: GspSession, payload: Record<string, unknown>): Promise<IrnResult>;
  cancelIrn(
    s: GspSession,
    irn: string,
    reason: string,
    remarks: string,
  ): Promise<{ cancelledAt: string }>;
  /** The IRN already made for a document (to recover from a duplicate). */
  getIrnByDocument(
    s: GspSession,
    doc: { type: string; number: string; date: string },
  ): Promise<IrnResult | null>;

  generateEwb(s: GspSession, payload: Record<string, unknown>): Promise<EwbResult>;
  updateVehicle(
    s: GspSession,
    ewbNo: string,
    v: {
      vehicleNo: string;
      fromPlace: string;
      fromState: string;
      reason: string;
      remarks: string;
      mode: string;
    },
  ): Promise<{ validUntil: string }>;
  extendEwb(
    s: GspSession,
    ewbNo: string,
    e: {
      remainingKm: number;
      fromPlace: string;
      fromState: string;
      fromPincode: string;
      reason: string;
      remarks: string;
      vehicleNo?: string;
    },
  ): Promise<{ validUntil: string }>;
  cancelEwb(
    s: GspSession,
    ewbNo: string,
    reason: string,
    remarks: string,
  ): Promise<{ cancelledAt: string }>;
  getEwb(s: GspSession, ewbNo: string): Promise<EwbStatus>;

  /** Used by prompt 46 (GSTR push and pull); adapters may leave them unimplemented until then. */
  pushGstr1(
    s: GspSession,
    period: string,
    payload: Record<string, unknown>,
  ): Promise<{ reference: string }>;
  pullGstr2b(s: GspSession, period: string): Promise<Record<string, unknown>>;
}

/** A failure the app can explain: the portal's or vendor's code, and its message. */
export class GspError extends Error {
  override name = 'GspError';
  constructor(
    readonly code: string,
    message: string,
    /** Whatever the portal sent back, for the log (redacted before it is stored). */
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

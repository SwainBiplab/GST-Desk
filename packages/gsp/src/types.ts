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

/** `gstn` is the return portal (GSTR-1, 2A, 2B), which logs in with an OTP the taxpayer receives, not a password. */
export type Portal = 'einvoice' | 'ewaybill' | 'gstn';

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

/** Who is logging in to the return portal: the GSTIN and the API user name created there. No password is kept. */
export interface GstnLogin {
  gstin: string;
  username: string;
}

/** The portal sent an OTP to the taxpayer's registered number; this names that request. */
export interface OtpChallenge {
  txnId: string;
  /** Epoch milliseconds the OTP stops being accepted. */
  expiresAt: number;
}

/** What the portal made of one table of a pushed return. */
export interface PushTableResult {
  table: string;
  status: 'ok' | 'error';
  /** Documents accepted (or refused, for an error). */
  count: number;
  errors: { code: string; message: string; ref?: string }[];
}

export interface PushResult {
  /** The portal's reference for this upload, to ask about it later. */
  reference: string;
  tables: PushTableResult[];
}

export interface PushStatus extends PushResult {
  state: 'processing' | 'processed' | 'error';
}

/** Whether a return has been filed on the portal, with the acknowledgement it gave. */
export interface FilingState {
  filed: boolean;
  arn: string | null;
  /** YYYY-MM-DD */
  filedOn: string | null;
}

export type ReturnForm = 'gstr1' | 'iff';

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

  /**
   * The return portal (prompt 46). The OTP goes to the taxpayer, who types it in: nothing here asks for it
   * on their behalf, and no password is stored. A session lasts about six hours.
   */
  requestGstnOtp(login: GstnLogin): Promise<OtpChallenge>;
  verifyGstnOtp(login: GstnLogin, txnId: string, otp: string): Promise<GspSession>;
  /** Save a return's tables on the portal. Saving the same period again replaces it; nothing is filed. */
  pushGstr1(
    s: GspSession,
    period: string,
    payload: Record<string, unknown>,
    opts?: { form?: ReturnForm; nil?: boolean },
  ): Promise<PushResult>;
  /** How the portal got on with an upload (it processes it after accepting it). */
  getPushStatus(s: GspSession, period: string, reference: string): Promise<PushStatus>;
  /** Whether the return was filed (by the taxpayer, on the portal), and its ARN. */
  getFilingState(s: GspSession, period: string, form: 'gstr1' | 'gstr3b'): Promise<FilingState>;
  pullGstr2b(s: GspSession, period: string): Promise<Record<string, unknown>>;
  pullGstr2a(s: GspSession, period: string): Promise<Record<string, unknown>>;
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

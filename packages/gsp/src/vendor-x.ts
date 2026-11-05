/**
 * A scaffold for a real GSP, written against a generic REST shape most GSPs resemble: a login that
 * returns a token, then JSON calls with the token and the GSTIN in headers, errors as `{ code, message }`.
 *
 * It is NOT wired to any real vendor and has never been run against one. Each `TODO(vendor)` marks a
 * place where a vendor's documentation decides the answer (paths, header names, encryption of the
 * payload, the shape of errors). See the package README for how to wire a vendor in.
 */
import type { IrnResult } from '@gst/domain';

import {
  GspError,
  type EwbResult,
  type EwbStatus,
  type GspAdapter,
  type GspCredentials,
  type GspSession,
  type Portal,
} from './types';

export interface VendorXConfig {
  /** For example https://sandbox.example-gsp.in. */
  baseUrl: string;
  sandbox: boolean;
  /** Milliseconds before a call is given up (the queue retries it). */
  timeoutMs?: number;
  /** Injected for tests; the browser's fetch otherwise. */
  fetch?: typeof fetch;
}

type Json = Record<string, any>;

export class VendorXAdapter implements GspAdapter {
  readonly name = 'vendor-x';
  readonly sandbox: boolean;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: VendorXConfig) {
    this.sandbox = cfg.sandbox;
    this.f = cfg.fetch ?? ((...a) => fetch(...a));
  }

  private async request(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    method = 'POST',
  ): Promise<Json> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
    try {
      const res = await this.f(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => ({}))) as Json;
      // TODO(vendor): the shape of an error differs by vendor (status codes, nesting, code field name)
      if (!res.ok || json['status'] === 'error' || json['success'] === false) {
        const err = (json['error'] ?? json) as Json;
        throw new GspError(
          String(err['code'] ?? res.status),
          String(err['message'] ?? res.statusText),
          json,
        );
      }
      return (json['data'] ?? json) as Json;
    } finally {
      clearTimeout(timer);
    }
  }

  private auth(s: GspSession): Record<string, string> {
    // TODO(vendor): header names for the token and the GSTIN
    return { authorization: `Bearer ${s.token}`, gstin: s.gstin };
  }

  async authenticate(creds: GspCredentials, portal: Portal): Promise<GspSession> {
    // TODO(vendor): many GSPs encrypt the password with the portal's public key and exchange an app key
    const user = portal === 'einvoice' ? creds.einvUser : creds.ewbUser;
    const pass = portal === 'einvoice' ? creds.einvPassword : creds.ewbPassword;
    if (!user || !pass)
      throw new GspError('GD-NO-CREDENTIALS', `No ${portal} user is set for ${creds.gstin}.`);
    const d = await this.request(`/${portal}/auth`, {
      gstin: creds.gstin,
      username: user,
      password: pass,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    });
    return {
      portal,
      gstin: creds.gstin,
      token: String(d['token'] ?? d['AuthToken']),
      expiresAt:
        Date.parse(String(d['expiry'] ?? d['TokenExpiry'] ?? '')) || Date.now() + 6 * 3_600_000,
    };
  }

  async generateIrn(s: GspSession, payload: Json): Promise<IrnResult> {
    const d = await this.request('/einvoice/irn', payload, this.auth(s));
    return {
      irn: String(d['Irn']),
      ackNo: String(d['AckNo']),
      ackDate: String(d['AckDt']),
      signedInvoice: String(d['SignedInvoice']),
      signedQr: String(d['SignedQRCode']),
      ewbNo: d['EwbNo'] ? String(d['EwbNo']) : null,
      ewbValidUntil: d['EwbValidTill'] ? String(d['EwbValidTill']) : null,
    };
  }

  async cancelIrn(s: GspSession, irn: string, reason: string, remarks: string) {
    const d = await this.request(
      '/einvoice/irn/cancel',
      { Irn: irn, CnlRsn: reason, CnlRem: remarks },
      this.auth(s),
    );
    return { cancelledAt: String(d['CancelDate']) };
  }

  async getIrnByDocument(s: GspSession, doc: { type: string; number: string; date: string }) {
    // TODO(vendor): "get IRN by document details" is a GET on most GSPs, with the document in the query
    try {
      const d = await this.request(
        `/einvoice/irn/by-document?doctype=${encodeURIComponent(doc.type)}&docnum=${encodeURIComponent(doc.number)}&docdate=${encodeURIComponent(doc.date)}`,
        null,
        this.auth(s),
        'GET',
      );
      return {
        irn: String(d['Irn']),
        ackNo: String(d['AckNo']),
        ackDate: String(d['AckDt']),
        signedInvoice: String(d['SignedInvoice']),
        signedQr: String(d['SignedQRCode']),
      };
    } catch (e) {
      if (e instanceof GspError && /404|2283/.test(e.code)) return null;
      throw e;
    }
  }

  async generateEwb(s: GspSession, payload: Json): Promise<EwbResult> {
    const d = await this.request('/ewaybill/generate', payload, this.auth(s));
    return {
      ewbNo: String(d['ewayBillNo']),
      generatedAt: String(d['ewayBillDate']),
      validUntil: String(d['validUpto']),
      distanceKm: Number(d['distance'] ?? payload['transDistance'] ?? 0),
    };
  }

  async updateVehicle(s: GspSession, ewbNo: string, v: Parameters<GspAdapter['updateVehicle']>[2]) {
    const d = await this.request(
      '/ewaybill/vehicle',
      {
        ewbNo,
        vehicleNo: v.vehicleNo,
        fromPlace: v.fromPlace,
        fromState: v.fromState,
        reasonCode: v.reason,
        reasonRem: v.remarks,
        transMode: v.mode,
      },
      this.auth(s),
    );
    return { validUntil: String(d['validUpto']) };
  }

  async extendEwb(s: GspSession, ewbNo: string, x: Parameters<GspAdapter['extendEwb']>[2]) {
    const d = await this.request(
      '/ewaybill/extend',
      {
        ewbNo,
        remainingDistance: x.remainingKm,
        fromPlace: x.fromPlace,
        fromState: x.fromState,
        fromPincode: x.fromPincode,
        extnRsnCode: x.reason,
        extnRemarks: x.remarks,
        vehicleNo: x.vehicleNo,
      },
      this.auth(s),
    );
    return { validUntil: String(d['validUpto']) };
  }

  async cancelEwb(s: GspSession, ewbNo: string, reason: string, remarks: string) {
    const d = await this.request(
      '/ewaybill/cancel',
      { ewbNo, cancelRsnCode: reason, cancelRmrk: remarks },
      this.auth(s),
    );
    return { cancelledAt: String(d['cancelDate']) };
  }

  async getEwb(s: GspSession, ewbNo: string): Promise<EwbStatus> {
    const d = await this.request(
      `/ewaybill/${encodeURIComponent(ewbNo)}`,
      null,
      this.auth(s),
      'GET',
    );
    return {
      ewbNo,
      generatedAt: String(d['ewayBillDate']),
      validUntil: String(d['validUpto']),
      distanceKm: Number(d['distance'] ?? 0),
      status: String(d['status']).toUpperCase() === 'CNL' ? 'cancelled' : 'active',
      vehicleNo: d['vehicleNo'] ? String(d['vehicleNo']) : null,
    };
  }

  async pushGstr1(): Promise<{ reference: string }> {
    throw new GspError('GD-NOT-YET', 'Filing GSTR-1 through the GSP arrives with prompt 46.');
  }

  async pullGstr2b(): Promise<Record<string, unknown>> {
    throw new GspError('GD-NOT-YET', 'Pulling GSTR-2B through the GSP arrives with prompt 46.');
  }
}

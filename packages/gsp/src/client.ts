/**
 * What the app talks to: one adapter, the credentials (unlocked for this session only), a login per
 * portal reused until it expires, one automatic retry after a refused login, the duplicate-IRN case
 * turned into "here is the IRN you already have", and every call written to the audit log with secrets
 * removed.
 */
import type { IrnResult } from '@gst/domain';

import { redact } from './redact';
import {
  GspError,
  type EwbResult,
  type EwbStatus,
  type GspAdapter,
  type GspCredentials,
  type GspSession,
  type Portal,
} from './types';

export interface GspLogEntry {
  portal: Portal;
  action: string;
  /** Redacted: no passwords, secrets or tokens. */
  request: unknown;
  response: unknown;
  ok: boolean;
  code: string | null;
  message: string | null;
  ms: number;
  at: number;
}

export interface GspClientOptions {
  /** The unlocked credentials, or null when they are locked (or not set). */
  credentials: () => GspCredentials | null;
  /** Called after every call, with secrets removed. */
  log?: (e: GspLogEntry) => void | Promise<void>;
  now?: () => number;
}

/** Errors that are not the portal's own become one of ours, so they can be explained. */
function asGspError(e: unknown): GspError {
  if (e instanceof GspError) return e;
  if (e instanceof TypeError) return new GspError('GD-OFFLINE', 'The portal could not be reached.');
  if (e instanceof Error && e.name === 'AbortError')
    return new GspError('GD-TIMEOUT', 'The portal did not answer in time.');
  return new GspError('GD-UNKNOWN', e instanceof Error ? e.message : String(e));
}

export class GspClient {
  private readonly sessions = new Map<Portal, GspSession>();

  constructor(
    readonly adapter: GspAdapter,
    private readonly opts: GspClientOptions,
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private async record(e: Omit<GspLogEntry, 'at'>): Promise<void> {
    try {
      await this.opts.log?.({
        ...e,
        request: redact(e.request),
        response: redact(e.response),
        at: this.now(),
      });
    } catch {
      // a failing log must not hide the result of the call itself
    }
  }

  private async session(portal: Portal, fresh = false): Promise<GspSession> {
    const have = this.sessions.get(portal);
    if (!fresh && have && have.expiresAt > this.now() + 60_000) return have;
    const creds = this.opts.credentials();
    if (!creds)
      throw new GspError('GD-LOCKED', 'The portal credentials are locked on this device.');
    const t0 = this.now();
    try {
      const s = await this.adapter.authenticate(creds, portal);
      this.sessions.set(portal, s);
      await this.record({
        portal,
        action: 'authenticate',
        request: { gstin: creds.gstin },
        response: { expiresAt: s.expiresAt },
        ok: true,
        code: null,
        message: null,
        ms: this.now() - t0,
      });
      return s;
    } catch (e) {
      const err = asGspError(e);
      await this.record({
        portal,
        action: 'authenticate',
        request: { gstin: creds.gstin },
        response: err.detail ?? null,
        ok: false,
        code: err.code,
        message: err.message,
        ms: this.now() - t0,
      });
      throw err;
    }
  }

  /** One call: logged, and tried once more with a fresh login if the login was refused. */
  private async call<T>(
    portal: Portal,
    action: string,
    request: unknown,
    fn: (s: GspSession) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this.session(portal, attempt > 0);
      const t0 = this.now();
      try {
        const out = await fn(s);
        await this.record({
          portal,
          action,
          request,
          response: out,
          ok: true,
          code: null,
          message: null,
          ms: this.now() - t0,
        });
        return out;
      } catch (e) {
        const err = asGspError(e);
        await this.record({
          portal,
          action,
          request,
          response: err.detail ?? null,
          ok: false,
          code: err.code,
          message: err.message,
          ms: this.now() - t0,
        });
        if ((err.code === 'GD-AUTH' || err.code === '238') && attempt === 0) {
          this.sessions.delete(portal);
          continue;
        }
        throw err;
      }
    }
    throw new GspError('GD-AUTH', 'The login was refused twice.');
  }

  /**
   * Generate an IRN. A duplicate (2150) means the portal already has one for this document: it is
   * fetched and returned, marked `recovered`, so a retry after a lost answer never fails.
   */
  async generateIrn(
    payload: Record<string, unknown>,
    doc: { type: string; number: string; date: string },
  ): Promise<IrnResult & { recovered: boolean }> {
    try {
      const r = await this.call('einvoice', 'generateIrn', payload, (s) =>
        this.adapter.generateIrn(s, payload),
      );
      return { ...r, recovered: false };
    } catch (e) {
      if (!(e instanceof GspError) || e.code !== '2150') throw e;
      const prior = await this.call('einvoice', 'getIrnByDocument', doc, (s) =>
        this.adapter.getIrnByDocument(s, doc),
      );
      if (!prior) throw e;
      return { ...prior, recovered: true };
    }
  }

  cancelIrn(irn: string, reason: string, remarks: string) {
    return this.call('einvoice', 'cancelIrn', { irn, reason, remarks }, (s) =>
      this.adapter.cancelIrn(s, irn, reason, remarks),
    );
  }

  generateEwb(payload: Record<string, unknown>): Promise<EwbResult> {
    return this.call('ewaybill', 'generateEwb', payload, (s) =>
      this.adapter.generateEwb(s, payload),
    );
  }

  updateVehicle(ewbNo: string, v: Parameters<GspAdapter['updateVehicle']>[2]) {
    return this.call('ewaybill', 'updateVehicle', { ewbNo, ...v }, (s) =>
      this.adapter.updateVehicle(s, ewbNo, v),
    );
  }

  extendEwb(ewbNo: string, x: Parameters<GspAdapter['extendEwb']>[2]) {
    return this.call('ewaybill', 'extendEwb', { ewbNo, ...x }, (s) =>
      this.adapter.extendEwb(s, ewbNo, x),
    );
  }

  cancelEwb(ewbNo: string, reason: string, remarks: string) {
    return this.call('ewaybill', 'cancelEwb', { ewbNo, reason, remarks }, (s) =>
      this.adapter.cancelEwb(s, ewbNo, reason, remarks),
    );
  }

  getEwb(ewbNo: string): Promise<EwbStatus> {
    return this.call('ewaybill', 'getEwb', { ewbNo }, (s) => this.adapter.getEwb(s, ewbNo));
  }
}

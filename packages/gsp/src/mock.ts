/**
 * A practice GSP that behaves like the portals: it takes time to answer, its login expires, it refuses a
 * second IRN for the same document (2150), an IRN cancellation after 24 hours (2270) or while an e-way
 * bill is active (2230), and an extension outside the window (315). Nothing it returns is real: IRNs
 * and e-way bill numbers are made up, and the QR is signed with a practice key.
 *
 * Used by the tests, and by the app as "Practice mode" until a real GSP is set up.
 */
import { ewbCancellable, ewbExtendable, ewbValidUntil, irnCancellable } from '@gst/domain';

import {
  GspError,
  type EwbResult,
  type EwbStatus,
  type FilingState,
  type GspAdapter,
  type GspCredentials,
  type GspSession,
  type GstnLogin,
  type OtpChallenge,
  type Portal,
  type PushResult,
  type PushStatus,
  type PushTableResult,
  type ReturnForm,
} from './types';

export interface MockOptions {
  /** Milliseconds each call takes (0 in tests). */
  latencyMs?: number;
  /** How long a login lasts. The portals use six hours. */
  tokenTtlMs?: number;
  /** The clock (tests move it). */
  now?: () => Date;
  /** The next calls fail with these codes, in order (to rehearse errors). */
  failWith?: string[];
  /** What a previous practice portal remembered (from `state()`), so it survives a reload. */
  state?: MockState | null;
  /** The OTP the practice return portal accepts. */
  otp?: string;
  /** Invoice and note numbers the practice return portal refuses on upload (to rehearse a partial failure). */
  rejectNumbers?: string[];
  /** How many times an upload is asked about before it shows as processed. */
  pollsToProcess?: number;
}

/** Everything the practice portal remembers, as plain JSON. */
export interface MockState {
  serial: number;
  irns: IrnRecord[];
  ewbs: EwbRecord[];
}

export interface IrnRecord {
  irn: string;
  ackNo: string;
  ackDate: string;
  signedInvoice: string;
  signedQr: string;
  docKey: string;
  status: 'active' | 'cancelled';
  ewbNo: string | null;
}

export interface EwbRecord extends EwbStatus {
  irn: string | null;
}

const b64url = (s: string): string =>
  btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const istStamp = (d: Date): string => {
  const ist = new Date(d.getTime() + 5.5 * 3_600_000);
  return ist.toISOString().slice(0, 19).replace('T', ' ');
};
const istIso = (d: Date): string => {
  const ist = new Date(d.getTime() + 5.5 * 3_600_000);
  return `${ist.toISOString().slice(0, 19)}+05:30`;
};

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Json = Record<string, any>;

interface PushRecord {
  reference: string;
  hash: string;
  tables: PushTableResult[];
  polls: number;
}

export class MockGspAdapter implements GspAdapter {
  readonly name = 'practice';
  readonly sandbox = true;
  /** Practice portal state for the return portal. */
  private readonly otps = new Map<string, { login: GstnLogin; expiresAt: number }>();
  private readonly pushes = new Map<string, PushRecord>();
  private readonly gstr2b = new Map<string, Record<string, unknown>>();
  private readonly gstr2a = new Map<string, Record<string, unknown>>();
  private readonly filed = new Map<string, { arn: string; filedOn: string }>();
  /** Calls made to the return portal, in order, for tests to count (metering). */
  readonly gstnCalls: string[] = [];
  private readonly irns = new Map<string, IrnRecord>();
  private readonly byDoc = new Map<string, string>();
  private readonly ewbs = new Map<string, EwbRecord>();
  private readonly tokens = new Map<string, number>();
  private serial = 0;
  private readonly opts: Required<Omit<MockOptions, 'failWith' | 'state' | 'rejectNumbers'>> & {
    failWith: string[];
    rejectNumbers: Set<string>;
  };

  constructor(opts: MockOptions = {}) {
    this.opts = {
      latencyMs: opts.latencyMs ?? 0,
      tokenTtlMs: opts.tokenTtlMs ?? 6 * 3_600_000,
      now: opts.now ?? (() => new Date()),
      failWith: [...(opts.failWith ?? [])],
      otp: opts.otp ?? '123456',
      rejectNumbers: new Set(opts.rejectNumbers ?? []),
      pollsToProcess: opts.pollsToProcess ?? 0,
    };
    const st = opts.state;
    if (st) {
      this.serial = st.serial;
      for (const r of st.irns) {
        this.irns.set(r.irn, { ...r });
        this.byDoc.set(r.docKey, r.irn);
      }
      for (const e of st.ewbs) this.ewbs.set(e.ewbNo, { ...e });
    }
  }

  /** What this practice portal remembers, to be saved and given back as `state` later. */
  state(): MockState {
    return {
      serial: this.serial,
      irns: [...this.irns.values()].map((r) => ({ ...r })),
      ewbs: [...this.ewbs.values()].map((e) => ({ ...e })),
    };
  }

  /** Make the next call fail with this code (a rehearsal of an error). */
  failNext(code: string): void {
    this.opts.failWith.push(code);
  }

  private async step(s?: GspSession): Promise<void> {
    if (this.opts.latencyMs > 0) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    const code = this.opts.failWith.shift();
    if (code) throw new GspError(code, `Practice error ${code}`);
    if (s) {
      const until = this.tokens.get(s.token);
      if (until === undefined || until < this.opts.now().getTime())
        throw new GspError('GD-AUTH', 'The login token has expired.');
    }
  }

  async authenticate(creds: GspCredentials, portal: Portal): Promise<GspSession> {
    await this.step();
    const user = portal === 'einvoice' ? creds.einvUser : creds.ewbUser;
    const pass = portal === 'einvoice' ? creds.einvPassword : creds.ewbPassword;
    if (!user || !pass)
      throw new GspError('GD-NO-CREDENTIALS', `No ${portal} user is set for ${creds.gstin}.`);
    if (pass === 'wrong') throw new GspError('GD-AUTH', 'Invalid user name or password.');
    const token = `practice-${portal}-${++this.serial}`;
    const expiresAt = this.opts.now().getTime() + this.opts.tokenTtlMs;
    this.tokens.set(token, expiresAt);
    return { portal, gstin: creds.gstin, token, expiresAt };
  }

  /** Expire every login now (to rehearse a token running out). */
  expireTokens(): void {
    for (const k of this.tokens.keys()) this.tokens.set(k, 0);
  }

  async generateIrn(s: GspSession, payload: Json) {
    await this.step(s);
    const doc = payload['DocDtls'] as Json;
    const seller = payload['SellerDtls'] as Json;
    const docKey = `${seller['Gstin']}|${doc['Typ']}|${String(doc['No']).toUpperCase()}`;
    if (this.byDoc.has(docKey)) {
      const prior = this.irns.get(this.byDoc.get(docKey)!)!;
      throw new GspError('2150', 'Duplicate IRN', {
        Irn: prior.irn,
        AckNo: prior.ackNo,
        AckDt: prior.ackDate,
      });
    }
    // the portal makes the IRN as the SHA-256 of GSTIN, year, type and number
    const irn = await sha256Hex(`${docKey}|${String(doc['Dt']).slice(-4)}`);
    const now = this.opts.now();
    const ackNo = String(112_000_000_000_000 + ++this.serial);
    const ackDate = istStamp(now);
    const items = (payload['ItemList'] as Json[]) ?? [];
    const qr = {
      SellerGstin: seller['Gstin'],
      BuyerGstin: (payload['BuyerDtls'] as Json)['Gstin'],
      DocNo: doc['No'],
      DocTyp: doc['Typ'],
      DocDt: doc['Dt'],
      TotInvVal: (payload['ValDtls'] as Json)['TotInvVal'],
      ItemCnt: items.length,
      MainHsnCode: items[0]?.['HsnCd'] ?? '',
      Irn: irn,
      IrnDt: ackDate,
    };
    const head = b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'PRACTICE' }));
    const signedQr = `${head}.${b64url(JSON.stringify({ data: JSON.stringify(qr), iss: 'PRACTICE' }))}.PRACTICE`;
    const signedInvoice = `${head}.${b64url(JSON.stringify({ data: JSON.stringify(payload), iss: 'PRACTICE' }))}.PRACTICE`;
    const rec: IrnRecord = {
      irn,
      ackNo,
      ackDate,
      signedInvoice,
      signedQr,
      docKey,
      status: 'active',
      ewbNo: null,
    };
    this.irns.set(irn, rec);
    this.byDoc.set(docKey, irn);
    return { irn, ackNo, ackDate, signedInvoice, signedQr, ewbNo: null, ewbValidUntil: null };
  }

  async cancelIrn(s: GspSession, irn: string, _reason: string, _remarks: string) {
    await this.step(s);
    const rec = this.irns.get(irn);
    if (!rec || rec.status === 'cancelled')
      throw new GspError('2283', 'IRN not found, or already cancelled.');
    if (!irnCancellable(rec.ackDate, this.opts.now()))
      throw new GspError('2270', 'The allowed cancellation time limit is crossed.');
    const active = [...this.ewbs.values()].some((e) => e.irn === irn && e.status === 'active');
    if (active) throw new GspError('2230', 'An active e-way bill exists for this IRN.');
    // the portal never allows a new IRN for the same number, even after cancellation (2150 again)
    rec.status = 'cancelled';
    return { cancelledAt: istIso(this.opts.now()) };
  }

  async getIrnByDocument(s: GspSession, doc: { type: string; number: string; date: string }) {
    await this.step(s);
    for (const rec of this.irns.values()) {
      if (
        rec.status === 'active' &&
        rec.docKey.endsWith(`|${doc.type}|${doc.number.toUpperCase()}`)
      )
        return {
          irn: rec.irn,
          ackNo: rec.ackNo,
          ackDate: rec.ackDate,
          signedInvoice: rec.signedInvoice,
          signedQr: rec.signedQr,
        };
    }
    return null;
  }

  async generateEwb(s: GspSession, payload: Json): Promise<EwbResult> {
    await this.step(s);
    const now = this.opts.now();
    // the portal works the distance out from the pincodes when it is sent as 0
    let km = Number(payload['transDistance'] ?? 0);
    if (!km)
      km = Math.max(
        1,
        Math.abs(Number(payload['fromPincode']) - Number(payload['toPincode'])) % 1500,
      );
    const generatedAt = istIso(now);
    const ewbNo = String(3_410_0000_0000 + ++this.serial);
    const validUntil = ewbValidUntil(
      generatedAt.slice(0, 10),
      km,
      payload['vehicleType'] === 'O' ? 'odc' : 'regular',
    );
    this.ewbs.set(ewbNo, {
      ewbNo,
      generatedAt,
      validUntil,
      distanceKm: km,
      status: 'active',
      vehicleNo: (payload['vehicleNo'] as string) ?? null,
      irn: (payload['Irn'] as string) ?? null,
    });
    return { ewbNo, generatedAt, validUntil, distanceKm: km };
  }

  private ewb(no: string): EwbRecord {
    const e = this.ewbs.get(no);
    if (!e || e.status !== 'active')
      throw new GspError('312', 'This e-way bill is either not generated by you or cancelled.');
    return e;
  }

  async updateVehicle(s: GspSession, ewbNo: string, v: { vehicleNo: string }) {
    await this.step(s);
    const e = this.ewb(ewbNo);
    e.vehicleNo = v.vehicleNo;
    return { validUntil: e.validUntil };
  }

  async extendEwb(s: GspSession, ewbNo: string, x: { remainingKm: number }) {
    await this.step(s);
    const e = this.ewb(ewbNo);
    const now = this.opts.now();
    if (!ewbExtendable(e.validUntil, now))
      throw new GspError('315', 'Validity period cannot be extended now.');
    e.validUntil = ewbValidUntil(istIso(now).slice(0, 10), x.remainingKm);
    return { validUntil: e.validUntil };
  }

  async cancelEwb(s: GspSession, ewbNo: string, _reason: string, _remarks: string) {
    await this.step(s);
    const e = this.ewb(ewbNo);
    if (!ewbCancellable(e.generatedAt, this.opts.now()))
      throw new GspError('315', 'The e-way bill can be cancelled only within 24 hours.');
    e.status = 'cancelled';
    return { cancelledAt: istIso(this.opts.now()) };
  }

  async getEwb(s: GspSession, ewbNo: string): Promise<EwbStatus> {
    await this.step(s);
    const e = this.ewbs.get(ewbNo);
    if (!e) throw new GspError('312', 'No such e-way bill.');
    const { irn: _irn, ...rest } = e;
    return { ...rest };
  }

  /* ---------------------------------------------------------------------------- return portal */

  readonly canFile = false;

  async requestGstnOtp(login: GstnLogin): Promise<OtpChallenge> {
    await this.step();
    this.gstnCalls.push('otp');
    if (!login.username) throw new GspError('GD-NO-CREDENTIALS', 'No GST portal user name is set.');
    const txnId = `txn-${++this.serial}`;
    const expiresAt = this.opts.now().getTime() + 10 * 60_000;
    this.otps.set(txnId, { login, expiresAt });
    return { txnId, expiresAt };
  }

  async verifyGstnOtp(login: GstnLogin, txnId: string, otp: string): Promise<GspSession> {
    await this.step();
    this.gstnCalls.push('verify');
    const t = this.otps.get(txnId);
    if (!t || t.login.gstin !== login.gstin) throw new GspError('AUTH4033', 'Unknown OTP request.');
    if (t.expiresAt < this.opts.now().getTime())
      throw new GspError('AUTH4034', 'The OTP has expired.');
    if (otp !== this.opts.otp) throw new GspError('AUTH4033', 'Invalid OTP.');
    this.otps.delete(txnId);
    const token = `practice-gstn-${++this.serial}`;
    const expiresAt = this.opts.now().getTime() + this.opts.tokenTtlMs;
    this.tokens.set(token, expiresAt);
    return { portal: 'gstn', gstin: login.gstin, token, expiresAt };
  }

  async pushGstr1(
    s: GspSession,
    period: string,
    payload: Json,
    o: { form?: ReturnForm; nil?: boolean } = {},
  ): Promise<PushResult> {
    await this.step(s);
    this.gstnCalls.push('push');
    if (payload['gstin'] !== s.gstin)
      throw new GspError('RET191106', 'The file is for a different GSTIN than the login.');
    if (payload['fp'] !== period)
      throw new GspError('RET191107', 'The file is for a different period.');
    const key = `${s.gstin}|${period}|${o.form ?? 'gstr1'}`;
    const hash = await sha256Hex(JSON.stringify(payload));
    const had = this.pushes.get(key);
    // the same file again is the same upload: the portal's reference does not change and nothing doubles
    if (had && had.hash === hash) return { reference: had.reference, tables: had.tables };
    const tables: PushTableResult[] = [];
    if (o.nil || payload['nil_return'])
      tables.push({ table: 'nil', status: 'ok', count: 0, errors: [] });
    for (const [table, v] of Object.entries(payload)) {
      if (['gstin', 'fp', 'nil_return'].includes(table) || !Array.isArray(v)) continue;
      const docs: { ref: string }[] = [];
      for (const p of v as Json[]) {
        for (const i of (p['inv'] ?? p['nt'] ?? [p]) as Json[])
          docs.push({ ref: String(i['inum'] ?? i['nt_num'] ?? i['doc_num'] ?? table) });
      }
      const bad = docs.filter((d) => this.opts.rejectNumbers.has(d.ref));
      tables.push(
        bad.length
          ? {
              table,
              status: 'error',
              count: bad.length,
              errors: bad.map((d) => ({
                code: 'RET13504',
                message: 'The invoice failed a portal check.',
                ref: d.ref,
              })),
            }
          : { table, status: 'ok', count: docs.length, errors: [] },
      );
    }
    const reference = `${had ? 'REF-R' : 'REF-'}${String(++this.serial).padStart(6, '0')}`;
    this.pushes.set(key, { reference, hash, tables, polls: 0 });
    return { reference, tables };
  }

  async getPushStatus(s: GspSession, period: string, reference: string): Promise<PushStatus> {
    await this.step(s);
    this.gstnCalls.push('status');
    const rec = [...this.pushes.entries()].find(
      ([k, v]) => k.startsWith(`${s.gstin}|${period}|`) && v.reference === reference,
    )?.[1];
    if (!rec) throw new GspError('RET13509', 'No such upload.');
    if (rec.polls++ < this.opts.pollsToProcess)
      return { reference, tables: [], state: 'processing' };
    return {
      reference,
      tables: rec.tables,
      state: rec.tables.some((t) => t.status === 'error') ? 'error' : 'processed',
    };
  }

  /** Practice: say the taxpayer filed this return on the portal. */
  setFiled(
    gstin: string,
    period: string,
    form: 'gstr1' | 'gstr3b',
    arn: string,
    filedOn: string,
  ): void {
    this.filed.set(`${gstin}|${period}|${form}`, { arn, filedOn });
  }

  async getFilingState(
    s: GspSession,
    period: string,
    form: 'gstr1' | 'gstr3b',
  ): Promise<FilingState> {
    await this.step(s);
    this.gstnCalls.push('filing');
    const f = this.filed.get(`${s.gstin}|${period}|${form}`);
    return f
      ? { filed: true, arn: f.arn, filedOn: f.filedOn }
      : { filed: false, arn: null, filedOn: null };
  }

  /** Practice: what the portal will return as this period's GSTR-2B / 2A. */
  setGstr2b(period: string, json: Record<string, unknown>): void {
    this.gstr2b.set(period, json);
  }
  setGstr2a(period: string, json: Record<string, unknown>): void {
    this.gstr2a.set(period, json);
  }

  async pullGstr2b(s: GspSession, period: string): Promise<Record<string, unknown>> {
    await this.step(s);
    this.gstnCalls.push('2b');
    const j = this.gstr2b.get(period);
    if (!j) throw new GspError('RTN00024', 'GSTR-2B for this period is not generated yet.');
    return j;
  }

  async pullGstr2a(s: GspSession, period: string): Promise<Record<string, unknown>> {
    await this.step(s);
    this.gstnCalls.push('2a');
    const j = this.gstr2a.get(period);
    if (!j) throw new GspError('RTN00024', 'GSTR-2A for this period is not available yet.');
    return j;
  }
}

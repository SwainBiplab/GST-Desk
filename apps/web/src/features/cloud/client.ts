/**
 * The app's client for the cloud API (prompt 40): sign in with a one-time code, keep the bearer token,
 * organisations and businesses. Plain `fetch` against `/v1`; every response is the API's own shape and
 * every error its envelope. Nothing is sent unless the person has set an API address and signed in.
 */

import type { CloudPermissions as CloudPermissionsAnswer } from '@/features/team/permissions';

export interface CloudSession {
  baseUrl: string;
  token: string;
  email: string;
  signedInAt: number;
}

export interface CloudMe {
  user: { id: string; email: string | null; phone: string | null; name: string; locale: string };
  organisations: { id: string; name: string; role: string }[];
  activeOrganizationId: string | null;
}

export interface CloudBusiness {
  id: string;
  legalName: string;
  tradeName: string | null;
  gstin: string | null;
  stateCode: string;
  scheme: 'regular' | 'composition';
  fyStartMonth: number;
  version: number;
}

/** Team (prompt 42): the API's shapes for members, invitations, roles and approvals. */
export interface TeamDevice {
  id: string;
  name: string;
  platform: string | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
}
export interface TeamMember {
  memberId: string;
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  roleId: string | null;
  roleName: string;
  createdAt: number;
  devices: TeamDevice[];
}
export interface TeamInvite {
  id: string;
  email: string | null;
  phone: string | null;
  role: string;
  roleId: string | null;
  roleName: string;
  status: string;
  expiresAt: number;
  createdAt: number;
}
export interface CustomRole {
  id: string;
  name: string;
  grants: Record<string, string[]>;
  members: number;
}
export interface Team {
  members: TeamMember[];
  invites: TeamInvite[];
  roles: CustomRole[];
  policy: { approvals: boolean };
}
export interface MyInvite {
  id: string;
  orgId: string;
  orgName: string;
  roleName: string;
  invitedBy: string;
  expiresAt: number;
}
export interface SignIn {
  at: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}
export type RoleChoice = { role: string } | { roleId: string };
export type ApprovalOutcome = {
  outcome: 'approved' | 'declined' | 'conflict' | 'refused';
  reason?: string;
  reviewItemId?: string;
};

/** Messaging (prompt 44): the API's shapes for settings, templates, the outbox and the log. */
export type MessageKind = 'invoice' | 'receipt' | 'reminder';
export interface DispatchSettings {
  onIssue: Record<string, boolean>;
  onPayment: boolean;
  reminders: boolean;
  offsets: number[];
  quietStart: string;
  quietEnd: string;
  autoSend: Record<string, boolean>;
  channel: 'whatsapp_first' | 'email_first' | 'whatsapp' | 'email';
  defaultLanguage: string;
}
export interface MessagingStatus {
  plan: string;
  enabled: boolean;
  used: number;
  limit: number;
  channels: { whatsapp: boolean; email: boolean };
}
export interface MessageTemplate {
  id: string;
  kind: MessageKind;
  language: string;
  name: string;
  body: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'paused';
  reason: string | null;
}
export interface OutboxMessage {
  id: string;
  party_id: string | null;
  document_id: string | null;
  kind: MessageKind;
  channel: 'whatsapp' | 'email';
  to_address: string;
  language: string;
  subject: string | null;
  body: string;
  created_at: string | number;
}
export interface LoggedMessage extends OutboxMessage {
  status: string;
  approval: string;
  error: string | null;
  timeline: { status: string; detail: string | null; at: number }[];
}
export interface RecurringInvoice {
  id: string;
  name: string;
  frequency: string;
  every: number;
  next_run: string;
  end_date: string | null;
  active: boolean;
  send: boolean;
  runs: number;
  last_error: string | null;
}

export interface GatewayStatus {
  connected: boolean;
  configured: boolean;
  provider: string | null;
  mode: 'test' | 'live' | null;
  active: boolean;
  keyId: string | null;
  lastError: string | null;
  lastOkAt: number | null;
  webhookPath: string | null;
}
export interface PaymentRequest {
  id: string;
  documentId: string;
  kind: 'link' | 'qr';
  /** A link's address, or the UPI payload a QR is drawn from. */
  url: string | null;
  imageUrl: string | null;
  amountPaise: number;
  paidPaise: number;
  partialAllowed: boolean;
  expiresAt: number;
  status: 'created' | 'partial' | 'paid' | 'expired' | 'cancelled';
}
export interface OnlinePayment {
  id: string;
  providerPaymentId: string;
  documentId: string | null;
  partyId: string | null;
  amountPaise: number;
  feePaise: number;
  refundedPaise: number;
  method: string;
  status: 'received' | 'processing' | 'matched' | 'unmatched';
  settlementId: string | null;
  at: number;
}
export interface GatewaySettlement {
  id: string;
  amountPaise: number;
  feePaise: number;
  utr: string | null;
  status: string;
  at: number;
  expectedPaise: number | null;
  matched: boolean;
}
export interface GatewayRefund {
  id: string;
  gatewayPaymentId: string;
  creditNoteId: string;
  amountPaise: number;
  status: 'requested' | 'rejected' | 'processing' | 'processed' | 'failed';
  error: string | null;
  requestedBy: string;
  decidedBy: string | null;
  createdAt: number;
}

export type FilingJobStatus =
  'queued' | 'running' | 'waiting_otp' | 'processing' | 'done' | 'partial' | 'failed';
export interface FilingJob {
  id: string;
  businessId: string;
  kind: 'push' | 'pull_2b' | 'pull_2a' | 'poll_filing';
  form: string | null;
  period: string;
  status: FilingJobStatus;
  reference: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface PortalSession {
  configured: boolean;
  practice: boolean;
  vendor: string | null;
  connected: boolean;
  expiresAt: number | null;
  username: string | null;
  gstin: string | null;
  otpPending: boolean;
}
export interface FilingStatusView {
  entitlement: { enabled: boolean; used: number; limit: number };
  session: PortalSession;
  jobs: FilingJob[];
}
export interface FilingDesk {
  due: string;
  nil: boolean;
  filed: boolean;
  lateFee: {
    days: number;
    perDayPaise: number;
    capPaise: number;
    feePaise: number;
    capped: boolean;
    version: string;
  };
}
export type BoardCellStatus = 'filed' | 'pushed' | 'exported' | 'late' | 'open';
export interface BoardCell {
  fp: string;
  ret: 'gstr1' | 'gstr3b';
  status: BoardCellStatus;
  due: string;
  overdueDays: number;
  lateFeePaise: number;
}
export interface BoardRow {
  orgId: string;
  orgName: string;
  businessId: string;
  businessName: string;
  gstin: string;
  cells: BoardCell[];
  exceptions: { kind: 'overdue' | 'blockers' | 'itc'; message: string; amount: number }[];
}
export interface FilingBoard {
  rows: BoardRow[];
  today: string;
  periods: string[];
}
export interface SharePerms {
  read: boolean;
  gst: boolean;
  export: boolean;
  comment: boolean;
}
export interface ShareView {
  id: string;
  businessId: string;
  email: string;
  status: 'pending' | 'active' | 'revoked' | 'declined';
  from: string;
  to: string;
  perms: SharePerms;
  expiresAt: number | null;
  note: string | null;
  createdAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
}
export interface ShareInvite {
  id: string;
  orgName: string;
  businessName: string;
  gstin: string | null;
  from: string;
  to: string;
  perms: SharePerms;
  note: string | null;
  createdAt: number;
}
export interface ClientRow extends BoardRow {
  via: 'share' | 'member';
  share: { id: string; from: string; to: string; perms: SharePerms } | null;
  stateCode: string;
  waiting: number;
  lastSyncAt: number | null;
  documents: number;
}
export interface ClientOverview {
  business: {
    id: string;
    name: string;
    legalName: string;
    gstin: string | null;
    stateCode: string;
    scheme: string;
    fyStartMonth: number;
  };
  access: {
    via: 'share' | 'member';
    from: string | null;
    to: string | null;
    perms: SharePerms | null;
  };
  cells: BoardCell[];
  exceptions: BoardRow['exceptions'];
  counts: { sales: number; purchases: number; notes: number; all: number };
}
export interface ClientDocument {
  id: string;
  type: string;
  number: string | null;
  date: string;
  partyName: string | null;
  status: string;
  totalPaise: number;
  irn: boolean;
}
export interface ClientComment {
  id: string;
  documentId: string | null;
  number: string | null;
  text: string;
  by: string;
  byName: string;
  status: string;
  createdAt: number;
}
export interface ExportPack {
  id: string;
  businessId: string;
  from: string;
  to: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  sizeBytes: number | null;
  manifest: {
    files: { name: string; bytes: number }[];
    counts: Record<string, number>;
    warnings: string[];
  } | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}
export interface PortalSettings {
  enabled: boolean;
  linkDays: number;
  statements: boolean;
  questions: boolean;
}
export interface PortalLink {
  id: string;
  kind: 'document' | 'statement';
  documentId: string | null;
  partyId: string | null;
  url: string | null;
  expiresAt: number;
  status: 'live' | 'expired' | 'revoked';
  views: number;
  lastViewedAt: number | null;
  createdAt: number;
}
export interface PortalLine {
  description: string;
  hsn: string | null;
  qty: string;
  unit: string | null;
  ratePaise: number;
  taxablePaise: number;
  gstRateBp: number;
  totalPaise: number;
}
export interface PortalBusiness {
  name: string;
  gstin: string | null;
  address: string[];
  phone: string | null;
  email: string | null;
}
export interface PortalDocumentPage {
  kind: 'document';
  business: PortalBusiness;
  document: {
    type: string;
    number: string | null;
    date: string;
    dueDate: string | null;
    partyName: string | null;
    placeOfSupply: string | null;
    status: 'issued' | 'cancelled';
    lines: PortalLine[];
    taxablePaise: number;
    taxPaise: number;
    roundOffPaise: number;
    totalPaise: number;
    paidPaise: number;
    balancePaise: number;
    payStatus: 'paid' | 'part' | 'unpaid' | 'not_payable';
    notes: string | null;
    terms: string | null;
  };
  pay: { available: boolean; url: string | null };
  questions: boolean;
  expiresAt: number;
}
export interface PortalStatementPage {
  kind: 'statement';
  business: PortalBusiness;
  party: { name: string; gstin: string | null };
  openingPaise: number;
  closingPaise: number;
  lines: {
    date: string;
    kind: string;
    ref: string;
    description: string;
    debitPaise: number;
    creditPaise: number;
    balancePaise: number;
  }[];
  questions: boolean;
  expiresAt: number;
}
export type PortalPage = PortalDocumentPage | PortalStatementPage;
/* the cloud AI gateway (prompt 48) */
export interface AiQuota {
  enabled: boolean;
  configured: boolean;
  used: number;
  limit: number;
  warning: boolean;
}
export interface AiUsageView {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
export interface AiMeta {
  model: string;
  usage: AiUsageView;
  latencyMs: number;
  quota: { used: number; limit: number; warning: boolean };
}
export interface AiBill {
  supplierName: string;
  supplierGstin: string | null;
  invoiceNumber: string;
  date: string;
  lines: {
    description: string;
    hsn: string | null;
    qty: number;
    ratePaise: number;
    gstRateBp: number;
  }[];
  totalPaise: number;
}
export interface AiExtraction extends AiMeta {
  bill: AiBill;
  supplier: { partyId: string | null; confidence: number };
  lineMatches: { itemId: string | null; confidence: number }[];
  checks: Record<string, unknown>;
  fieldConfidence: Record<string, number>;
}
export interface AiExplanation extends AiMeta {
  explanation: string;
  likelyCause: string;
  suggestedAction: string;
  confidence: number;
}
export interface AiNoticeSummary extends AiMeta {
  noticeType: string;
  form: string | null;
  issuedBy: string | null;
  referenceNumber: string | null;
  dateIssued: string | null;
  dueDate: string | null;
  demandPaise: number | null;
  summary: string;
  actions: string[];
  references: string[];
  needsProfessional: boolean;
}
export interface AiBooksAnswer {
  answer: string;
  toolCalls: { name: string; arguments: unknown }[];
  model: string;
  usage: AiUsageView;
  latencyMs: number;
  quota: { used: number; limit: number; warning: boolean };
}
export interface AiGstAnswer {
  answer: string;
  sources: { title: string; heading: string; source: string; date: string; quote: string }[];
  disclaimer: string;
  covered: boolean;
  model: string | null;
  quota: { used: number; limit: number; warning: boolean };
}
export interface AiBatch {
  id: string;
  kind: string;
  status: 'queued' | 'submitted' | 'done' | 'failed';
  items: number;
  counts: Record<string, number> | null;
  results: unknown[] | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

const SESSION_KEY = 'cloud.session';
const URL_KEY = 'cloud.url';

export const readCloudUrl = (get: (k: string) => string | null): string => get(URL_KEY) ?? '';
export const writeCloudUrl = (set: (k: string, v: string) => void, url: string) =>
  set(URL_KEY, url.trim().replace(/\/$/, ''));

declare const __DEBUG_API__: boolean;

/** A private network address (the emulator's host, a LAN machine): plain http is allowed there in a debug build. */
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+(\.\d+)?$/;

/** Only https, or plain http to this machine for development (and, in a debug phone build, to the LAN). */
export function isAllowedApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    if (u.protocol !== 'http:') return false;
    if (['localhost', '127.0.0.1'].includes(u.hostname)) return true;
    return typeof __DEBUG_API__ !== 'undefined' && __DEBUG_API__ && PRIVATE_V4.test(u.hostname);
  } catch {
    return false;
  }
}

export function readSession(get: (k: string) => string | null): CloudSession | null {
  try {
    const raw = get(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as CloudSession;
    return s.token && s.baseUrl ? s : null;
  } catch {
    return null;
  }
}

/**
 * The token is kept in local storage for now; the desktop keychain is B-060. It is scoped to the API
 * address it was issued by and is cleared by sign-out.
 */
export const writeSession = (set: (k: string, v: string | null) => void, s: CloudSession | null) =>
  set(SESSION_KEY, s ? JSON.stringify(s) : null);

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string; requestId?: string } } | null)
      ?.error;
    const flat = body as { code?: string; message?: string } | null;
    const m = (body as { message?: string } | null)?.message;
    throw new CloudError(
      res.status,
      e?.code ?? flat?.code ?? 'http_error',
      e?.message ?? m ?? `The server answered ${res.status}.`,
      e?.requestId,
    );
  }
  return body as T;
}

export class CloudClient {
  constructor(
    readonly baseUrl: string,
    private token: string | null = null,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers as Record<string, string> | undefined),
    }).then((r) => parse<T>(r));
  }

  /** Step one of sign-in: ask for a code by email. */
  sendEmailCode(email: string): Promise<{ success: boolean }> {
    return this.call('/v1/auth/email-otp/send-verification-otp', {
      method: 'POST',
      body: JSON.stringify({ email, type: 'sign-in' }),
    });
  }

  /** Step one by phone. */
  sendPhoneCode(phone: string): Promise<{ code?: string }> {
    return this.call('/v1/auth/phone-number/send-otp', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber: phone }),
    });
  }

  /** Development servers hand back the code they "sent". */
  devCode(to: string): Promise<{ to: string; code: string }> {
    return this.call(`/v1/dev/otp?to=${encodeURIComponent(to)}`);
  }

  /** Step two: the code becomes a bearer token. */
  async signInWithEmailCode(email: string, otp: string, name?: string): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/auth/sign-in/email-otp`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ email, otp, ...(name ? { name } : {}) }),
    });
    await parse<unknown>(res);
    const token = res.headers.get('set-auth-token');
    if (!token) throw new CloudError(500, 'no_token', 'The server did not return a token.');
    this.token = token;
    return token;
  }

  /** Step two by phone: the code becomes a bearer token (a first sign-in makes the account). */
  async signInWithPhoneCode(phone: string, code: string): Promise<string> {
    const res = await this.fetchFn(`${this.baseUrl}/v1/auth/phone-number/verify`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ phoneNumber: phone, code }),
    });
    await parse<unknown>(res);
    const token = res.headers.get('set-auth-token');
    if (!token) throw new CloudError(500, 'no_token', 'The server did not return a token.');
    this.token = token;
    return token;
  }

  /** The phone's push token, so the API can say when the inbox or a reminder has something new. */
  registerPushToken(o: { token: string; deviceId: string }): Promise<null> {
    return this.call('/v1/me/push-tokens', {
      method: 'POST',
      body: JSON.stringify({ ...o, platform: 'android' }),
    });
  }

  async signOut(): Promise<void> {
    try {
      await this.call('/v1/auth/sign-out', { method: 'POST', body: '{}' });
    } finally {
      this.token = null;
    }
  }

  me(): Promise<CloudMe> {
    return this.call('/v1/me');
  }

  createOrganisation(name: string): Promise<{ id: string; name: string; role: string }> {
    return this.call('/v1/orgs', { method: 'POST', body: JSON.stringify({ name }) });
  }

  businesses(orgId: string): Promise<CloudBusiness[]> {
    return this.call(`/v1/orgs/${orgId}/businesses`);
  }

  createBusiness(
    orgId: string,
    b: { legalName: string; stateCode: string; gstin?: string; scheme?: 'regular' | 'composition' },
  ): Promise<CloudBusiness> {
    return this.call(`/v1/orgs/${orgId}/businesses`, { method: 'POST', body: JSON.stringify(b) });
  }

  permissions(orgId: string): Promise<CloudPermissionsAnswer> {
    return this.call(`/v1/orgs/${orgId}/permissions`);
  }

  team(orgId: string): Promise<Team> {
    return this.call(`/v1/orgs/${orgId}/team`);
  }

  invite(
    orgId: string,
    to: { email: string } | { phone: string },
    role: RoleChoice,
  ): Promise<TeamInvite> {
    return this.call(`/v1/orgs/${orgId}/invites`, {
      method: 'POST',
      body: JSON.stringify({ ...to, ...role }),
    });
  }

  withdrawInvite(orgId: string, id: string): Promise<null> {
    return this.call(`/v1/orgs/${orgId}/invites/${id}`, { method: 'DELETE' });
  }

  changeRole(orgId: string, memberId: string, role: RoleChoice): Promise<null> {
    return this.call(`/v1/orgs/${orgId}/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify(role),
    });
  }

  removeMember(orgId: string, memberId: string): Promise<null> {
    return this.call(`/v1/orgs/${orgId}/members/${memberId}`, { method: 'DELETE' });
  }

  revokeDevice(orgId: string, deviceId: string): Promise<null> {
    return this.call(`/v1/orgs/${orgId}/devices/${deviceId}/revoke`, {
      method: 'POST',
      body: '{}',
    });
  }

  signIns(orgId: string, memberId: string): Promise<SignIn[]> {
    return this.call(`/v1/orgs/${orgId}/members/${memberId}/sign-ins`);
  }

  saveRole(
    orgId: string,
    role: { id?: string; name: string; grants: Record<string, string[]> },
  ): Promise<CustomRole | null> {
    return role.id
      ? this.call(`/v1/orgs/${orgId}/roles/${role.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: role.name, grants: role.grants }),
        })
      : this.call(`/v1/orgs/${orgId}/roles`, {
          method: 'POST',
          body: JSON.stringify({ name: role.name, grants: role.grants }),
        });
  }

  deleteRole(orgId: string, id: string): Promise<null> {
    return this.call(`/v1/orgs/${orgId}/roles/${id}`, { method: 'DELETE' });
  }

  setPolicy(orgId: string, approvals: boolean): Promise<{ approvals: boolean }> {
    return this.call(`/v1/orgs/${orgId}/policy`, {
      method: 'PUT',
      body: JSON.stringify({ approvals }),
    });
  }

  decideApproval(
    orgId: string,
    itemId: string,
    decision: 'approve' | 'decline',
    note?: string,
  ): Promise<ApprovalOutcome> {
    return this.call(`/v1/orgs/${orgId}/approvals/${itemId}`, {
      method: 'POST',
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    });
  }

  myInvites(): Promise<MyInvite[]> {
    return this.call('/v1/me/invites');
  }

  answerInvite(id: string, accept: boolean): Promise<{ orgId: string }> {
    return this.call(`/v1/invites/${id}/${accept ? 'accept' : 'decline'}`, {
      method: 'POST',
      body: '{}',
    });
  }

  private m(orgId: string, path: string) {
    return `/v1/orgs/${orgId}/messaging${path}`;
  }

  messagingStatus(orgId: string): Promise<MessagingStatus> {
    return this.call(this.m(orgId, '/status'));
  }
  dispatchSettings(orgId: string, businessId: string): Promise<DispatchSettings> {
    return this.call(this.m(orgId, `/settings/${businessId}`));
  }
  saveDispatchSettings(
    orgId: string,
    businessId: string,
    s: DispatchSettings,
  ): Promise<DispatchSettings> {
    return this.call(this.m(orgId, `/settings/${businessId}`), {
      method: 'PUT',
      body: JSON.stringify(s),
    });
  }
  messageTemplates(orgId: string): Promise<MessageTemplate[]> {
    return this.call(this.m(orgId, '/templates'));
  }
  saveMessageTemplate(orgId: string, id: string, body: string): Promise<null> {
    return this.call(this.m(orgId, `/templates/${id}`), {
      method: 'PUT',
      body: JSON.stringify({ body }),
    });
  }
  previewTemplate(
    orgId: string,
    kind: MessageKind,
    language: string,
    body?: string,
  ): Promise<{ text: string; problems: string[] }> {
    return this.call(this.m(orgId, '/templates/preview'), {
      method: 'POST',
      body: JSON.stringify({ kind, language, ...(body ? { body } : {}) }),
    });
  }
  submitTemplates(
    orgId: string,
    language?: string,
  ): Promise<{ submitted: number; failed: string[] }> {
    return this.call(this.m(orgId, '/templates/submit'), {
      method: 'POST',
      body: JSON.stringify(language ? { language } : {}),
    });
  }
  syncTemplates(orgId: string): Promise<{ updated: number }> {
    return this.call(this.m(orgId, '/templates/sync'), { method: 'POST', body: '{}' });
  }
  outbox(orgId: string, businessId: string): Promise<OutboxMessage[]> {
    return this.call(this.m(orgId, `/outbox?businessId=${businessId}`));
  }
  approveMessage(orgId: string, id: string, edit?: { body?: string }): Promise<null> {
    return this.call(this.m(orgId, `/messages/${id}/approve`), {
      method: 'POST',
      body: JSON.stringify(edit ?? {}),
    });
  }
  rejectMessage(orgId: string, id: string): Promise<null> {
    return this.call(this.m(orgId, `/messages/${id}/reject`), { method: 'POST', body: '{}' });
  }
  sendMessage(
    orgId: string,
    b: { businessId: string; kind: MessageKind; documentId: string; paymentId?: string },
  ): Promise<{ id: string; approval: string; channel: string }> {
    return this.call(this.m(orgId, '/send'), { method: 'POST', body: JSON.stringify(b) });
  }
  messageLog(
    orgId: string,
    q: { documentId?: string; partyId?: string },
  ): Promise<LoggedMessage[]> {
    const qs = new URLSearchParams(q as Record<string, string>).toString();
    return this.call(this.m(orgId, `/log${qs ? `?${qs}` : ''}`));
  }
  consent(orgId: string, partyId: string): Promise<Record<string, 'opted_in' | 'opted_out'>> {
    return this.call(this.m(orgId, `/consent/${partyId}`));
  }
  setConsent(
    orgId: string,
    b: { partyId: string; channel: 'whatsapp' | 'email'; status: 'opted_in' | 'opted_out' },
  ): Promise<null> {
    return this.call(this.m(orgId, '/consent'), { method: 'PUT', body: JSON.stringify(b) });
  }
  private f(orgId: string, path: string) {
    return `/v1/orgs/${orgId}/filing${path}`;
  }
  filingStatus(orgId: string, businessId: string): Promise<FilingStatusView> {
    return this.call(this.f(orgId, `/status?businessId=${businessId}`));
  }
  requestPortalOtp(
    orgId: string,
    b: { businessId: string; username: string },
  ): Promise<PortalSession> {
    return this.call(this.f(orgId, '/otp'), { method: 'POST', body: JSON.stringify(b) });
  }
  verifyPortalOtp(orgId: string, b: { businessId: string; otp: string }): Promise<PortalSession> {
    return this.call(this.f(orgId, '/otp/verify'), { method: 'POST', body: JSON.stringify(b) });
  }
  signOutPortal(orgId: string, businessId: string): Promise<null> {
    return this.call(this.f(orgId, `/session?businessId=${businessId}`), { method: 'DELETE' });
  }
  startFilingJob(
    orgId: string,
    b: { businessId: string; kind: FilingJob['kind']; form?: string; period: string },
  ): Promise<{ id: string; existing: boolean }> {
    return this.call(this.f(orgId, '/jobs'), { method: 'POST', body: JSON.stringify(b) });
  }
  filingJobs(orgId: string, businessId: string): Promise<FilingJob[]> {
    return this.call(this.f(orgId, `/jobs?businessId=${businessId}`));
  }
  filingDesk(
    orgId: string,
    businessId: string,
    ret: 'gstr1' | 'gstr3b',
    period: string,
  ): Promise<FilingDesk> {
    return this.call(this.f(orgId, `/desk?businessId=${businessId}&ret=${ret}&period=${period}`));
  }
  filingPack(
    orgId: string,
    businessId: string,
    period: string,
  ): Promise<{ files: { name: string; content: string }[] }> {
    return this.call(this.f(orgId, `/pack?businessId=${businessId}&period=${period}`));
  }
  filingBoard(itcThresholdPaise?: number): Promise<FilingBoard> {
    return this.call(
      `/v1/me/filing-board${itcThresholdPaise === undefined ? '' : `?itcThresholdPaise=${itcThresholdPaise}`}`,
    );
  }
  private p(orgId: string, path: string) {
    return `/v1/orgs/${orgId}/payments${path}`;
  }
  gatewayStatus(orgId: string, businessId: string): Promise<GatewayStatus> {
    return this.call(this.p(orgId, `/gateway?businessId=${businessId}`));
  }
  connectGateway(
    orgId: string,
    b: { businessId: string; keyId: string; keySecret: string; webhookSecret: string },
  ): Promise<GatewayStatus> {
    return this.call(this.p(orgId, '/gateway'), { method: 'PUT', body: JSON.stringify(b) });
  }
  disconnectGateway(orgId: string, businessId: string): Promise<null> {
    return this.call(this.p(orgId, `/gateway?businessId=${businessId}`), { method: 'DELETE' });
  }
  createPaymentRequest(
    orgId: string,
    b: {
      businessId: string;
      documentId: string;
      kind: 'link' | 'qr';
      partialAllowed?: boolean;
      expiresInDays?: number;
    },
  ): Promise<PaymentRequest> {
    return this.call(this.p(orgId, '/requests'), { method: 'POST', body: JSON.stringify(b) });
  }
  paymentRequests(orgId: string, documentId: string): Promise<PaymentRequest[]> {
    return this.call(this.p(orgId, `/requests?documentId=${documentId}`));
  }
  paymentRequest(orgId: string, id: string): Promise<PaymentRequest> {
    return this.call(this.p(orgId, `/requests/${id}`));
  }
  onlinePayments(orgId: string, businessId: string, status?: string): Promise<OnlinePayment[]> {
    return this.call(
      this.p(orgId, `/online?businessId=${businessId}${status ? `&status=${status}` : ''}`),
    );
  }
  settlements(orgId: string, businessId: string): Promise<GatewaySettlement[]> {
    return this.call(this.p(orgId, `/settlements?businessId=${businessId}`));
  }
  syncSettlements(orgId: string, businessId: string): Promise<GatewaySettlement[]> {
    return this.call(this.p(orgId, '/settlements/sync'), {
      method: 'POST',
      body: JSON.stringify({ businessId }),
    });
  }
  gatewayRefunds(orgId: string, businessId: string): Promise<GatewayRefund[]> {
    return this.call(this.p(orgId, `/refunds?businessId=${businessId}`));
  }
  requestRefund(
    orgId: string,
    b: { businessId: string; gatewayPaymentId: string; creditNoteId: string; amountPaise: number },
  ): Promise<{ id: string }> {
    return this.call(this.p(orgId, '/refunds'), { method: 'POST', body: JSON.stringify(b) });
  }
  decideRefund(orgId: string, id: string, approve: boolean): Promise<{ status: string } | null> {
    return this.call(this.p(orgId, `/refunds/${id}/${approve ? 'approve' : 'reject'}`), {
      method: 'POST',
      body: '{}',
    });
  }
  /* -------------------------------------------------------------- sharing and portals (prompt 47) */
  shares(orgId: string, businessId: string): Promise<ShareView[]> {
    return this.call(`/v1/orgs/${orgId}/shares?businessId=${businessId}`);
  }
  share(
    orgId: string,
    b: {
      businessId: string;
      email?: string;
      phone?: string;
      fy?: string;
      from?: string;
      to?: string;
      perms: SharePerms;
      expiresAt?: number | null;
      note?: string | null;
    },
  ): Promise<ShareView> {
    return this.call(`/v1/orgs/${orgId}/shares`, { method: 'POST', body: JSON.stringify(b) });
  }
  revokeShare(orgId: string, id: string): Promise<ShareView> {
    return this.call(`/v1/orgs/${orgId}/shares/${id}`, { method: 'DELETE' });
  }
  shareInvites(): Promise<ShareInvite[]> {
    return this.call('/v1/me/share-invites');
  }
  answerShare(id: string, accept: boolean): Promise<{ orgId: string; businessId: string }> {
    return this.call(`/v1/share-invites/${id}/${accept ? 'accept' : 'decline'}`, {
      method: 'POST',
    });
  }
  clients(): Promise<ClientRow[]> {
    return this.call('/v1/me/clients');
  }
  private cl(orgId: string, path: string) {
    return `/v1/orgs/${orgId}/client${path}`;
  }
  clientOverview(orgId: string, businessId: string): Promise<ClientOverview> {
    return this.call(this.cl(orgId, `/overview?businessId=${businessId}`));
  }
  clientDocuments(
    orgId: string,
    businessId: string,
    q: { from?: string; to?: string; type?: string; limit?: number; offset?: number } = {},
  ): Promise<{ rows: ClientDocument[]; count: number }> {
    const p = new URLSearchParams({ businessId });
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return this.call(this.cl(orgId, `/documents?${p.toString()}`));
  }
  clientDocument(
    orgId: string,
    businessId: string,
    id: string,
  ): Promise<{ document: Record<string, unknown>; lines: Record<string, unknown>[] }> {
    return this.call(this.cl(orgId, `/documents/${id}?businessId=${businessId}`));
  }
  clientPdfUrl(orgId: string, businessId: string, id: string): string {
    return `${this.baseUrl}${this.cl(orgId, `/documents/${id}/pdf?businessId=${businessId}`)}`;
  }
  async clientPdf(orgId: string, businessId: string, id: string): Promise<Blob> {
    const r = await this.fetchFn(this.clientPdfUrl(orgId, businessId, id), {
      headers: this.headers(),
    });
    if (!r.ok) await parse(r);
    return r.blob();
  }
  clientComments(orgId: string, businessId: string): Promise<ClientComment[]> {
    return this.call(this.cl(orgId, `/comments?businessId=${businessId}`));
  }
  addClientComment(
    orgId: string,
    b: { businessId: string; documentId: string | null; text: string },
  ): Promise<ClientComment> {
    return this.call(this.cl(orgId, '/comments'), { method: 'POST', body: JSON.stringify(b) });
  }
  exportPacks(orgId: string, businessId: string): Promise<ExportPack[]> {
    return this.call(this.cl(orgId, `/export-packs?businessId=${businessId}`));
  }
  requestExportPack(
    orgId: string,
    b: { businessId: string; from: string; to: string },
  ): Promise<ExportPack> {
    return this.call(this.cl(orgId, '/export-packs'), { method: 'POST', body: JSON.stringify(b) });
  }
  exportPackDownload(orgId: string, id: string): Promise<{ url: string; expiresAt: number }> {
    return this.call(this.cl(orgId, `/export-packs/${id}/download`));
  }
  portalSettings(orgId: string, businessId: string): Promise<PortalSettings> {
    return this.call(`/v1/orgs/${orgId}/portal/settings?businessId=${businessId}`);
  }
  savePortalSettings(
    orgId: string,
    b: { businessId: string } & Partial<PortalSettings>,
  ): Promise<PortalSettings> {
    return this.call(`/v1/orgs/${orgId}/portal/settings`, {
      method: 'PUT',
      body: JSON.stringify(b),
    });
  }
  portalLinks(
    orgId: string,
    businessId: string,
    q: { documentId?: string; partyId?: string } = {},
  ): Promise<PortalLink[]> {
    const p = new URLSearchParams({ businessId });
    if (q.documentId) p.set('documentId', q.documentId);
    if (q.partyId) p.set('partyId', q.partyId);
    return this.call(`/v1/orgs/${orgId}/portal/links?${p.toString()}`);
  }
  createPortalLink(
    orgId: string,
    b: { businessId: string; documentId?: string; partyId?: string; days?: number },
  ): Promise<PortalLink & { url: string }> {
    return this.call(`/v1/orgs/${orgId}/portal/links`, { method: 'POST', body: JSON.stringify(b) });
  }
  revokePortalLink(orgId: string, id: string): Promise<PortalLink> {
    return this.call(`/v1/orgs/${orgId}/portal/links/${id}`, { method: 'DELETE' });
  }
  /* ------------------------------------------------------------------- the cloud AI gateway (prompt 48) */
  private ai(orgId: string, path: string) {
    return `/v1/orgs/${orgId}/ai${path}`;
  }
  aiStatus(orgId: string): Promise<AiQuota> {
    return this.call(this.ai(orgId, '/status'));
  }
  aiExtractBill(
    orgId: string,
    b: { businessId: string; text?: string; file?: { name: string; mime: string; base64: string } },
  ): Promise<AiExtraction> {
    return this.call(this.ai(orgId, '/extract-bill'), { method: 'POST', body: JSON.stringify(b) });
  }
  aiExplainMismatch(
    orgId: string,
    b: { businessId: string; row: unknown },
  ): Promise<AiExplanation> {
    return this.call(this.ai(orgId, '/explain-mismatch'), {
      method: 'POST',
      body: JSON.stringify(b),
    });
  }
  aiSummariseNotice(
    orgId: string,
    b: { businessId: string; text?: string; file?: { name: string; mime: string; base64: string } },
  ): Promise<AiNoticeSummary> {
    return this.call(this.ai(orgId, '/summarise-notice'), {
      method: 'POST',
      body: JSON.stringify(b),
    });
  }
  aiAskBooks(
    orgId: string,
    b: {
      businessId: string;
      question: string;
      history?: { role: 'user' | 'assistant'; content: string }[];
    },
  ): Promise<AiBooksAnswer> {
    return this.call(this.ai(orgId, '/ask-books'), { method: 'POST', body: JSON.stringify(b) });
  }
  aiGstQa(orgId: string, b: { businessId: string; question: string }): Promise<AiGstAnswer> {
    return this.call(this.ai(orgId, '/gst-qa'), { method: 'POST', body: JSON.stringify(b) });
  }
  aiDraftMessage(
    orgId: string,
    b: { businessId: string; kind: string; language: string; context: Record<string, unknown> },
  ): Promise<{ text: string; language: string } & AiMeta> {
    return this.call(this.ai(orgId, '/draft-message'), { method: 'POST', body: JSON.stringify(b) });
  }
  aiBatches(orgId: string, businessId: string): Promise<AiBatch[]> {
    return this.call(this.ai(orgId, `/batches?businessId=${businessId}`));
  }
  aiCreateBatch(
    orgId: string,
    b: {
      businessId: string;
      kind: 'extract_bills' | 'categorise_statement';
      items: { id: string; text?: string; input?: Record<string, unknown> }[];
    },
  ): Promise<AiBatch> {
    return this.call(this.ai(orgId, '/batches'), { method: 'POST', body: JSON.stringify(b) });
  }
  aiBatch(orgId: string, id: string): Promise<AiBatch> {
    return this.call(this.ai(orgId, `/batches/${id}`));
  }

  /* the customer's public page: no session */
  portalPage(token: string): Promise<PortalPage> {
    return this.call(`/v1/p/${token}`);
  }
  portalPdfUrl(token: string): string {
    return `${this.baseUrl}/v1/p/${token}/pdf`;
  }
  portalPay(token: string): Promise<{ url: string; amountPaise: number; expiresAt: number }> {
    return this.call(`/v1/p/${token}/pay`, { method: 'POST' });
  }
  portalQuestion(
    token: string,
    b: { name: string | null; contact: string | null; text: string },
  ): Promise<{ ok: true }> {
    return this.call(`/v1/p/${token}/question`, { method: 'POST', body: JSON.stringify(b) });
  }

  recurringInvoices(orgId: string): Promise<RecurringInvoice[]> {
    return this.call(`/v1/orgs/${orgId}/recurring-invoices`);
  }
  createRecurring(orgId: string, b: Record<string, unknown>): Promise<{ id: string }> {
    return this.call(`/v1/orgs/${orgId}/recurring-invoices`, {
      method: 'POST',
      body: JSON.stringify(b),
    });
  }
  changeRecurring(
    orgId: string,
    id: string,
    b: { active?: boolean; send?: boolean },
  ): Promise<null> {
    return this.call(`/v1/orgs/${orgId}/recurring-invoices/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(b),
    });
  }

  health(): Promise<{ ok: boolean; version: string }> {
    return this.call('/healthz');
  }
}

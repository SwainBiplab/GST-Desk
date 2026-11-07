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

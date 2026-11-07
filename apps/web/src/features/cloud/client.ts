/**
 * The app's client for the cloud API (prompt 40): sign in with a one-time code, keep the bearer token,
 * organisations and businesses. Plain `fetch` against `/v1`; every response is the API's own shape and
 * every error its envelope. Nothing is sent unless the person has set an API address and signed in.
 */

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

/** Only https, or plain http to this machine for development. */
export function isAllowedApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' ||
      (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
    );
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

  health(): Promise<{ ok: boolean; version: string }> {
    return this.call('/healthz');
  }
}

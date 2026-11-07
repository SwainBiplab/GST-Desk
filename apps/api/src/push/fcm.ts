/**
 * Firebase Cloud Messaging, HTTP v1 (prompt 43): a service account's key signs a short-lived JWT, which
 * is exchanged for an access token, which sends a data message. No SDK: the whole exchange is three
 * small requests. A message carries a kind and a count only; the content stays in the book.
 */
import { createSign } from 'node:crypto';

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface PushData {
  kind: 'inbox' | 'reminder' | 'sync';
  count?: number;
}

const b64url = (s: string | Buffer) =>
  Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The JWT Google exchanges for an access token (RS256, one hour). */
export function serviceJwt(sa: ServiceAccount, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${b64url(sig)}`;
}

/** The message body FCM takes: data only, high priority so the phone wakes for a sync window. */
export function fcmMessage(token: string, data: PushData): Record<string, unknown> {
  return {
    message: {
      token,
      data: { kind: data.kind, ...(data.count !== undefined ? { count: String(data.count) } : {}) },
      android: { priority: 'high', ttl: '3600s' },
    },
  };
}

export class FcmSender {
  private access: { token: string; until: number } | null = null;

  constructor(
    private readonly sa: ServiceAccount,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async accessToken(): Promise<string> {
    if (this.access && this.access.until > Date.now() + 60_000) return this.access.token;
    const res = await this.fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: serviceJwt(this.sa),
      }),
    });
    if (!res.ok) throw new Error(`FCM token exchange answered ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.access = { token: body.access_token, until: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  /** Send to each token; tokens FCM says are gone come back so the caller can forget them. */
  async send(tokens: string[], data: PushData): Promise<{ sent: number; gone: string[] }> {
    const access = await this.accessToken();
    let sent = 0;
    const gone: string[] = [];
    for (const token of tokens) {
      const res = await this.fetchFn(
        `https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
          body: JSON.stringify(fcmMessage(token, data)),
        },
      );
      if (res.ok) sent += 1;
      else if (res.status === 404 || res.status === 410) gone.push(token);
    }
    return { sent, gone };
  }
}

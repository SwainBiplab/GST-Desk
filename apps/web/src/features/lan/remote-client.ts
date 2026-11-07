/**
 * The tablet end: pair with the desktop, keep the token, call methods, keep edit locks alive, and follow a
 * token rotation. It talks over `fetch` to the desktop's pinned-certificate server; the page itself was
 * loaded from that server, so the browser has already accepted its certificate for this origin.
 */
import { decode, encode, type Role } from '@gst/lan';

export interface TokenStore {
  get(): string | null;
  set(token: string | null): void;
}

export class RemoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

export interface RemoteOptions {
  /** `''` for the page's own origin. */
  base?: string;
  fetch?: typeof fetch;
  tokens: TokenStore;
}

export class RemoteClient {
  constructor(private readonly o: RemoteOptions) {}

  private f(): typeof fetch {
    return this.o.fetch ?? fetch;
  }

  /** Trade a one-time code for a device token, which is kept. */
  async pair(
    code: string,
    name: string,
    platform: string,
  ): Promise<{ deviceId: string; role: Role }> {
    const res = await this.f()(`${this.o.base ?? ''}/pair`, {
      method: 'POST',
      body: encode({ code, name, platform }),
    });
    const body = decode<{
      ok: boolean;
      result?: { token: string; deviceId: string; role: Role };
      error?: { code: string; message: string };
    }>(await res.text());
    if (!body.ok || !body.result)
      throw new RemoteError(
        body.error?.code ?? 'failed',
        body.error?.message ?? 'Pairing failed.',
        res.status,
      );
    this.o.tokens.set(body.result.token);
    return { deviceId: body.result.deviceId, role: body.result.role };
  }

  /** Call a method. A new token that comes back with the answer replaces the stored one. */
  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const token = this.o.tokens.get();
    if (!token) throw new RemoteError('no_token', 'Pair this device first.', 401);
    const res = await this.f()(`${this.o.base ?? ''}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: encode({ method, params }),
    });
    const body = decode<{
      ok: boolean;
      result?: T;
      rotatedToken?: string;
      error?: { code: string; message: string; [k: string]: unknown };
    }>(await res.text());
    if (body.rotatedToken) this.o.tokens.set(body.rotatedToken);
    if (res.status === 401 && (body.error?.code === 'revoked' || body.error?.code === 'bad_token'))
      this.o.tokens.set(null);
    if (!body.ok) {
      const { code, message, ...extra } = body.error ?? {
        code: 'failed',
        message: 'The request failed.',
      };
      throw new RemoteError(code, message, res.status, extra);
    }
    return body.result as T;
  }

  /** Keep an edit lock while a document is open. Returns a function that stops and lets the lock go. */
  holdLock(resource: string, onLost: (e: RemoteError) => void, everyMs = 30_000): () => void {
    let live = true;
    const timer = setInterval(() => {
      this.call('lock.heartbeat', { resource }).catch((e: unknown) => {
        if (live && e instanceof RemoteError && e.code === 'lock_lost') {
          live = false;
          clearInterval(timer);
          onLost(e);
        }
      });
    }, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
      void this.call('lock.release', { resource }).catch(() => undefined);
    };
  }
}

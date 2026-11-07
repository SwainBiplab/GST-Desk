/**
 * The bridge: a request that arrived over the network (already through TLS) becomes a call on the app, or
 * is refused. Everything that decides who may do what lives here: whether LAN access is on, whether the
 * token is good and not revoked, whether the device's role allows the method, whether another device is
 * editing the document, and whether the caller is asking too fast.
 *
 * A reply is `{ ok, result }` or `{ ok: false, error: { code, message } }`, as JSON text with bigints
 * carried by `wire.ts`. The HTTP status is 200 for a call that ran (even one that failed inside), 400,
 * 401, 403, 409, 429 or 503 for one the bridge itself refused.
 */
import { RateLimiter } from './limits';
import { EditLocks, type Holder } from './locks';
import { Pairer, type PairingOffer } from './pairing';
import { allows, isRole, type Access, type Role } from './roles';
import type { Device, DeviceStore } from './store';
import { TOKEN_GRACE_MS, TOKEN_ROTATE_AFTER_MS, hashToken, newToken } from './tokens';
import { decode, encode } from './wire';

export interface MethodDef {
  access: Access;
  /** For a call that changes a document being edited: the thing to lock. Null when there is nothing to lock. */
  lock?: (params: any) => string | null;
  /** Let the lock go when the call succeeds: the document is finished with (issued, cancelled). */
  releaseAfter?: boolean;
  run: (params: any, ctx: { device: Device }) => Promise<unknown>;
}

export interface BridgeRequest {
  route: 'pair' | 'rpc' | 'ping';
  /** The caller's address, for rate limits and lockouts. */
  ip: string;
  /** The bearer token, when there is one. */
  token?: string | undefined;
  body: string;
}

export interface BridgeResponse {
  status: number;
  body: string;
}

export interface BridgeOptions {
  store: DeviceStore;
  methods: ReadonlyMap<string, MethodDef>;
  clock: () => number;
  /** Whether LAN access is turned on. Off means every request is refused. */
  enabled: () => boolean;
  newId?: () => string;
}

const reply = (status: number, value: unknown): BridgeResponse => ({ status, body: encode(value) });
const fail = (status: number, code: string, message: string, extra: object = {}): BridgeResponse =>
  reply(status, { ok: false, error: { code, message, ...extra } });

export class LanBridge {
  readonly locks = new EditLocks();
  readonly pairer = new Pairer();
  private readonly perDevice = new RateLimiter(50, 100);
  private readonly perPairingSource = new RateLimiter(10 / 60, 10);
  private readonly perAnon = new RateLimiter(5, 20);

  constructor(private readonly o: BridgeOptions) {}

  /** The desktop asks for a code to show. */
  startPairing(role: Role): PairingOffer {
    return this.pairer.start(this.o.clock(), role);
  }

  async devices(): Promise<Device[]> {
    return (await this.o.store.list()).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Revoke at once: the token stops working on the next request and the locks it held are let go. */
  async revoke(id: string): Promise<boolean> {
    const d = (await this.o.store.list()).find((x) => x.id === id);
    if (!d || d.revokedAt !== null) return false;
    await this.o.store.save({ ...d, revokedAt: this.o.clock() });
    this.locks.releaseAll(id);
    return true;
  }

  async setRole(id: string, role: Role): Promise<boolean> {
    const d = (await this.o.store.list()).find((x) => x.id === id);
    if (!d || d.revokedAt !== null || !isRole(role)) return false;
    await this.o.store.save({ ...d, role });
    return true;
  }

  async rename(id: string, name: string): Promise<boolean> {
    const d = (await this.o.store.list()).find((x) => x.id === id);
    const n = name.trim();
    if (!d || n.length === 0 || n.length > 40) return false;
    await this.o.store.save({ ...d, name: n });
    return true;
  }

  async handle(req: BridgeRequest): Promise<BridgeResponse> {
    const now = this.o.clock();
    if (!this.o.enabled())
      return fail(503, 'lan_disabled', 'LAN access is turned off on this computer.');
    // strangers are limited by address; a paired device is limited by its own bucket once it is known
    if (req.route !== 'rpc' && !this.perAnon.allow(`ip:${req.ip}`, now))
      return fail(429, 'slow_down', 'Too many requests. Wait a moment.');
    if (req.route === 'ping') return reply(200, { ok: true });
    if (req.body.length > 1_000_000) return fail(400, 'too_large', 'The request is too large.');
    return req.route === 'pair' ? this.pair(req, now) : this.rpc(req, now);
  }

  private async pair(req: BridgeRequest, now: number): Promise<BridgeResponse> {
    if (!this.perPairingSource.allow(req.ip, now))
      return fail(429, 'slow_down', 'Too many tries. Wait a minute.');
    let b: { code?: unknown; name?: unknown; platform?: unknown };
    try {
      b = decode(req.body);
    } catch {
      return fail(400, 'bad_request', 'The request is not valid JSON.');
    }
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (typeof b.code !== 'string' || name.length === 0 || name.length > 40)
      return fail(
        400,
        'bad_request',
        'Send the code and a name for this device (up to 40 characters).',
      );
    const r = this.pairer.redeem(b.code, req.ip, now);
    if (!r.ok) {
      const msg: Record<string, string> = {
        no_offer: 'No pairing is open. Start one on the computer.',
        expired: 'That code has expired. Start a new one on the computer.',
        wrong_code: 'That code is not right.',
        locked: 'Too many wrong codes. Wait a minute.',
      };
      return fail(r.code === 'locked' ? 429 : 403, r.code, msg[r.code]!);
    }
    const token = newToken();
    const id = this.o.newId?.() ?? crypto.randomUUID();
    const device: Device = {
      id,
      name,
      platform: typeof b.platform === 'string' ? b.platform.slice(0, 40) : '',
      role: r.role,
      tokenHash: await hashToken(token),
      tokenIssuedAt: now,
      prevTokenHash: null,
      prevValidUntil: 0,
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    };
    await this.o.store.save(device);
    return reply(200, {
      ok: true,
      result: { token, deviceId: id, role: r.role, rotateAfterMs: TOKEN_ROTATE_AFTER_MS },
    });
  }

  private async rpc(req: BridgeRequest, now: number): Promise<BridgeResponse> {
    const unknown = (code: string, message: string) =>
      this.perAnon.allow(`ip:${req.ip}`, now)
        ? fail(401, code, message)
        : fail(429, 'slow_down', 'Too many requests. Wait a moment.');
    if (!req.token) return unknown('no_token', 'Pair this device first.');
    const hash = await hashToken(req.token);
    let device = await this.o.store.findByHash(hash, now);
    if (!device) return unknown('bad_token', 'This device is not paired.');
    if (device.revokedAt !== null)
      return fail(401, 'revoked', 'This device has been removed from the computer.');
    if (!this.perDevice.allow(`dev:${device.id}`, now))
      return fail(429, 'slow_down', 'Too many requests. Wait a moment.');

    let call: { method?: unknown; params?: unknown };
    try {
      call = decode(req.body);
    } catch {
      return fail(400, 'bad_request', 'The request is not valid JSON.');
    }
    if (typeof call.method !== 'string')
      return fail(400, 'bad_request', 'Name the method to call.');

    // a token past its age is replaced; the old one works a little longer in case the reply is lost
    let rotatedToken: string | undefined;
    if (device.tokenHash === hash && now - device.tokenIssuedAt >= TOKEN_ROTATE_AFTER_MS) {
      rotatedToken = newToken();
      device = {
        ...device,
        prevTokenHash: device.tokenHash,
        prevValidUntil: now + TOKEN_GRACE_MS,
        tokenHash: await hashToken(rotatedToken),
        tokenIssuedAt: now,
      };
    }
    device = { ...device, lastSeenAt: now };
    await this.o.store.save(device);
    const withToken = (v: object) => (rotatedToken ? { ...v, rotatedToken } : v);

    const who: Holder = { deviceId: device.id, name: device.name };
    const builtin = this.builtin(call.method, call.params, device, who, now);
    if (builtin) return reply(builtin.status, withToken(builtin.value));

    const m = this.o.methods.get(call.method);
    if (!m) return fail(404, 'no_method', `There is no method ${call.method}.`);
    if (!allows(device.role, m.access))
      return fail(403, 'forbidden', 'This device is not allowed to do that.', {
        role: device.role,
      });

    const resource = m.lock ? m.lock(call.params) : null;
    if (resource) {
      const l = this.locks.acquire(resource, who, now);
      if (!l.ok)
        return fail(409, 'locked', `Being edited on ${l.holder.name}.`, {
          holder: l.holder,
          resource,
        });
    }
    try {
      const result = await m.run(call.params, { device });
      if (resource && m.releaseAfter) this.locks.release(resource, device.id);
      return reply(200, withToken({ ok: true, result }));
    } catch (e) {
      return reply(
        200,
        withToken({
          ok: false,
          error: { code: 'failed', message: e instanceof Error ? e.message : String(e) },
        }),
      );
    }
  }

  /** The methods every device has: who am I, and the edit-lock calls. */
  private builtin(
    method: string,
    params: unknown,
    device: Device,
    who: Holder,
    now: number,
  ): { status: number; value: object } | null {
    const resource = (params as { resource?: unknown } | null)?.resource;
    const needResource = () =>
      typeof resource === 'string' && resource.length > 0 && resource.length <= 200;
    switch (method) {
      case 'whoami':
        return {
          status: 200,
          value: {
            ok: true,
            result: { deviceId: device.id, name: device.name, role: device.role },
          },
        };
      case 'lock.acquire':
      case 'lock.takeOver': {
        if (!allows(device.role, 'sell'))
          return {
            status: 403,
            value: {
              ok: false,
              error: { code: 'forbidden', message: 'This device may only look.' },
            },
          };
        if (!needResource())
          return {
            status: 400,
            value: { ok: false, error: { code: 'bad_request', message: 'Name the resource.' } },
          };
        const r =
          method === 'lock.acquire'
            ? this.locks.acquire(resource as string, who, now)
            : this.locks.takeOver(resource as string, who, now);
        return r.ok
          ? {
              status: 200,
              value: {
                ok: true,
                result: { held: true, ...(r.tookOverFrom ? { tookOverFrom: r.tookOverFrom } : {}) },
              },
            }
          : {
              status: 409,
              value: {
                ok: false,
                error: {
                  code: 'locked',
                  message: `Being edited on ${r.holder.name}.`,
                  holder: r.holder,
                },
              },
            };
      }
      case 'lock.heartbeat': {
        if (!needResource())
          return {
            status: 400,
            value: { ok: false, error: { code: 'bad_request', message: 'Name the resource.' } },
          };
        if (this.locks.heartbeat(resource as string, device.id, now))
          return { status: 200, value: { ok: true, result: { held: true } } };
        const h = this.locks.holderOf(resource as string, now);
        return {
          status: 409,
          value: {
            ok: false,
            error: {
              code: 'lock_lost',
              message: h ? `Taken over by ${h.name}.` : 'The edit lock lapsed.',
              ...(h ? { holder: h } : {}),
            },
          },
        };
      }
      case 'lock.release':
        if (needResource()) this.locks.release(resource as string, device.id);
        return { status: 200, value: { ok: true, result: { held: false } } };
      default:
        return null;
    }
  }
}

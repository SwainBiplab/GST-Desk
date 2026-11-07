/**
 * One writer at a time for a document being edited. A device takes the lock when it opens the document
 * and keeps it by sending a heartbeat; a lock nobody renews lapses. A second device is told who holds it
 * and can take over, which tells the first.
 */
export const LOCK_TTL_MS = 2 * 60 * 1000;

export interface Holder {
  deviceId: string;
  name: string;
}

interface Entry extends Holder {
  until: number;
}

export type LockResult = { ok: true; tookOverFrom?: Holder } | { ok: false; holder: Holder };

export class EditLocks {
  private readonly held = new Map<string, Entry>();

  private live(resource: string, now: number): Entry | null {
    const e = this.held.get(resource);
    if (!e) return null;
    if (e.until <= now) {
      this.held.delete(resource);
      return null;
    }
    return e;
  }

  holderOf(resource: string, now: number): Holder | null {
    const e = this.live(resource, now);
    return e ? { deviceId: e.deviceId, name: e.name } : null;
  }

  acquire(resource: string, who: Holder, now: number): LockResult {
    const e = this.live(resource, now);
    if (e && e.deviceId !== who.deviceId)
      return { ok: false, holder: { deviceId: e.deviceId, name: e.name } };
    this.held.set(resource, { ...who, until: now + LOCK_TTL_MS });
    return { ok: true };
  }

  /** Take it from whoever holds it. The result names them so they can be told. */
  takeOver(resource: string, who: Holder, now: number): LockResult {
    const e = this.live(resource, now);
    this.held.set(resource, { ...who, until: now + LOCK_TTL_MS });
    return e && e.deviceId !== who.deviceId
      ? { ok: true, tookOverFrom: { deviceId: e.deviceId, name: e.name } }
      : { ok: true };
  }

  /** Renew. False when the device no longer holds it (it lapsed, or someone took over). */
  heartbeat(resource: string, deviceId: string, now: number): boolean {
    const e = this.live(resource, now);
    if (!e || e.deviceId !== deviceId) return false;
    e.until = now + LOCK_TTL_MS;
    return true;
  }

  release(resource: string, deviceId: string): void {
    if (this.held.get(resource)?.deviceId === deviceId) this.held.delete(resource);
  }

  /** Everything a device holds, for when it is revoked. */
  releaseAll(deviceId: string): void {
    for (const [k, v] of this.held) if (v.deviceId === deviceId) this.held.delete(k);
  }
}

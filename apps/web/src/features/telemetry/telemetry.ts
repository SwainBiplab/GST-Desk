import { useSyncExternalStore } from 'react';

import {
  afterSend,
  clean,
  emptyState,
  isFeature,
  payload,
  record,
  sendDue,
  type Feature,
  type Payload,
  type TelemetryState,
} from './core';

import { isDesktop } from '@/features/desktop/bridge';

/**
 * Anonymous usage counters. Off until a person turns it on in Settings, Privacy. While it is off nothing
 * is stored or sent: `track` returns at once. While it is on, counts are kept on this device and, if this
 * build has a collection address (`VITE_TELEMETRY_URL`), sent about once a week. With no address they
 * simply stay here, and the Privacy screen says so. See `core.ts` for exactly what can be counted.
 */

const ON_KEY = 'gst.telemetry.on';
const STATE_KEY = 'gst.telemetry.state';
const URL = (import.meta.env['VITE_TELEMETRY_URL'] as string | undefined) || '';

declare const __APP_VERSION__: string;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage may be blocked: then nothing is kept, which is fine */
  }
}

const newId = () => crypto.randomUUID();

export const isOn = () => read(ON_KEY) === '1';

function load(): TelemetryState {
  try {
    const s = JSON.parse(read(STATE_KEY) ?? 'null') as Partial<TelemetryState> | null;
    if (s && typeof s.installId === 'string' && s.installId.length > 10)
      return {
        installId: s.installId,
        counts: clean(s.counts),
        lastSentAt: typeof s.lastSentAt === 'number' ? s.lastSentAt : null,
      };
  } catch {
    /* fall through to a fresh state */
  }
  // first use: make the id once and keep it, so it is the same on every read
  const fresh = emptyState(newId);
  write(STATE_KEY, JSON.stringify(fresh));
  return fresh;
}
const save = (s: TelemetryState) => write(STATE_KEY, JSON.stringify(s));

/** Count one use of a feature. Does nothing unless the person opted in. */
export function track(feature: Feature): void {
  if (!isOn() || !isFeature(feature)) return;
  save(record(load(), feature));
  emit();
}

export function setOn(on: boolean): void {
  write(ON_KEY, on ? '1' : null);
  // turning it off forgets everything that was waiting to be sent
  if (!on) write(STATE_KEY, null);
  emit();
}

/** A new random id, and the counts cleared: "start again as someone new". */
export function resetId(): void {
  write(STATE_KEY, JSON.stringify(emptyState(newId)));
  emit();
}

export const pending = (): Payload =>
  // while it is off nothing is stored, so there is no id to show
  isOn()
    ? payload(load(), __APP_VERSION__, isDesktop() ? 'desktop' : 'web')
    : payload(
        emptyState(() => ''),
        __APP_VERSION__,
        isDesktop() ? 'desktop' : 'web',
      );
export const hasAddress = () => URL !== '';

/** Send the counters if one is due and there is somewhere to send them. Never throws. */
export async function sendIfDue(now = Date.now()): Promise<boolean> {
  if (!isOn() || !URL) return false;
  const state = load();
  if (!sendDue(state, now)) return false;
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload(state, __APP_VERSION__, isDesktop() ? 'desktop' : 'web')),
      // no cookies, no referrer: the request carries the counts and nothing else
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!r.ok) return false;
    save(afterSend(load(), now));
    emit();
    return true;
  } catch {
    return false;
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useTelemetryOn = (): boolean => useSyncExternalStore(subscribe, isOn, () => false);
export const usePending = (): string =>
  useSyncExternalStore(
    subscribe,
    () => JSON.stringify(pending(), null, 2),
    () => '',
  );

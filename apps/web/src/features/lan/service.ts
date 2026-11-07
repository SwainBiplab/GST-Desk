/**
 * Tablet access on the desktop: starts and stops the Rust server, answers each request it hands over, and
 * tells the screen what is going on. One instance per window; nothing here runs in a browser.
 */
import type { Ctx, Database } from '@gst/db';
import type { LanBridge } from '@gst/lan';
import { useSyncExternalStore } from 'react';

import { lanReply, lanStart, lanStop, on, type LanStarted } from '../desktop/bridge';

import { LAN_REQUEST_EVENT, makeBridge, toBridgeRequest, type LanRequestEvent } from './host';

export const LAN_PORT_KEY = 'lan.port';
export const LAN_ON_KEY = 'lan.on';
export const DEFAULT_PORT = 8443;

export interface LanStatus {
  running: boolean;
  starting: boolean;
  info: LanStarted | null;
  /** Why it could not start, as the server said it. `not_built` means this build has no tablet access. */
  error: string | null;
}

let status: LanStatus = { running: false, starting: false, info: null, error: null };
let bridge: LanBridge | null = null;
let unlisten: (() => void) | null = null;
const listeners = new Set<() => void>();

const set = (next: Partial<LanStatus>) => {
  status = { ...status, ...next };
  listeners.forEach((l) => l());
};

export const lanStatus = (): LanStatus => status;
export const lanBridge = (): LanBridge | null => bridge;
export const useLanStatus = (): LanStatus =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function startLan(
  d: Database,
  ctx: Ctx,
  opts: { port: number; inventoryEnabled: () => boolean },
): Promise<void> {
  if (status.running || status.starting) return;
  set({ starting: true, error: null });
  try {
    bridge = makeBridge(d, ctx, {
      inventoryEnabled: opts.inventoryEnabled,
      enabled: () => status.running,
    });
    const b = bridge;
    const stop = await on<LanRequestEvent>(LAN_REQUEST_EVENT, (e) => {
      void b.handle(toBridgeRequest(e)).then(
        (r) => lanReply(e.id, r.status, r.body),
        () =>
          lanReply(
            e.id,
            500,
            '{"ok":false,"error":{"code":"internal","message":"The computer could not answer."}}',
          ),
      );
    });
    unlisten = stop;
    // the bridge answers only while "running" is true, so mark it before the first request can arrive
    status = { ...status, running: true };
    const info = await lanStart(opts.port);
    set({ starting: false, running: true, info });
  } catch (e) {
    unlisten?.();
    unlisten = null;
    bridge = null;
    set({ starting: false, running: false, info: null, error: errText(e) });
  }
}

export async function stopLan(): Promise<void> {
  set({ running: false });
  unlisten?.();
  unlisten = null;
  bridge = null;
  await lanStop().catch(() => undefined);
  set({ info: null, starting: false });
}

export const readLanPort = (get: (k: string) => string | null): number => {
  const n = Number(get(LAN_PORT_KEY));
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_PORT;
};

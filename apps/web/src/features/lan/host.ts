/**
 * The desktop end of the bridge: the Rust server hands each request to the window as an event; this
 * answers it with `LanBridge.handle` and sends the reply back. Nothing here runs in a browser.
 */
import type { Ctx, Database } from '@gst/db';
import { LanBridge, type BridgeRequest } from '@gst/lan';

import { lanMethods, type MethodOptions } from './methods';
import { DbDeviceStore } from './store';

export interface LanRequestEvent {
  id: number;
  route: 'ping' | 'pair' | 'rpc';
  ip: string;
  token: string | null;
  body: string;
}

export const LAN_REQUEST_EVENT = 'lan-request';

export function makeBridge(
  d: Database,
  ctx: Ctx,
  opts: MethodOptions & { enabled: () => boolean; clock?: () => number },
): LanBridge {
  return new LanBridge({
    store: new DbDeviceStore(d, ctx),
    methods: lanMethods(d, ctx, opts),
    clock: opts.clock ?? Date.now,
    enabled: opts.enabled,
  });
}

/** Turn the Rust event into a bridge request. */
export const toBridgeRequest = (e: LanRequestEvent): BridgeRequest => ({
  route: e.route,
  ip: e.ip,
  token: e.token ?? undefined,
  body: e.body,
});

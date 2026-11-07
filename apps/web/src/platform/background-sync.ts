/**
 * Background sync windows (prompt 43). Android decides when background work runs: the app asks
 * WorkManager for a periodic window (every 30 minutes at the earliest, only with a network, not on a
 * low battery) through the app's own native plugin (`BackgroundSyncPlugin.kt`). When a window opens
 * and the app's process is alive, the plugin tells the page, which runs one sync; when the process is
 * not alive, nothing runs and the next open syncs. Sync never runs in the background outside a window.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { hasPlugin } from './index';

interface BackgroundSyncPlugin {
  schedule(o: { everyMinutes: number }): Promise<void>;
  cancel(): Promise<void>;
  /** Is Firebase set up in this build (push needs it)? */
  pushAvailable(): Promise<{ available: boolean }>;
  addListener(event: 'window', fn: () => void): Promise<PluginListenerHandle>;
}

const BackgroundSync = registerPlugin<BackgroundSyncPlugin>('BackgroundSync', {
  web: () =>
    Promise.resolve({
      schedule: async () => undefined,
      cancel: async () => undefined,
      pushAvailable: async () => ({ available: false }),
      addListener: async () => ({ remove: async () => undefined }),
    }),
});

export const DEFAULT_WINDOW_MINUTES = 30;

/** A build without `google-services.json` has no Firebase: registering for push would crash the app. */
export async function pushConfigured(): Promise<boolean> {
  if (!hasPlugin('BackgroundSync')) return false;
  return (await BackgroundSync.pushAvailable()).available;
}

export async function scheduleBackgroundSync(everyMinutes = DEFAULT_WINDOW_MINUTES): Promise<void> {
  if (!hasPlugin('BackgroundSync')) return;
  await BackgroundSync.schedule({ everyMinutes: Math.max(15, everyMinutes) });
}

export async function cancelBackgroundSync(): Promise<void> {
  if (!hasPlugin('BackgroundSync')) return;
  await BackgroundSync.cancel();
}

/** Run `fn` when a window opens. Returns how to stop listening. */
export async function onSyncWindow(fn: () => void): Promise<() => Promise<void>> {
  if (!hasPlugin('BackgroundSync')) return async () => undefined;
  const h = await BackgroundSync.addListener('window', fn);
  return () => h.remove();
}

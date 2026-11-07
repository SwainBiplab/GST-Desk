/**
 * Push notifications (prompt 43): the phone registers with Firebase Cloud Messaging through Capacitor
 * and gives the API its token; the API sends a message when an inbox item or a reminder is for this
 * person. A message carries only a kind and a count, never the content: the content is in the book,
 * which the app reads once it opens (or syncs). Nothing is registered until sync is on.
 */
import { pushConfigured } from './background-sync';

import { hasPlugin } from './index';

export interface PushMessage {
  kind: 'inbox' | 'reminder' | 'sync';
  count?: number;
}

type Handle = { remove(): Promise<void> };

/** Ask for permission and a token. Resolves null when refused or not on a phone. */
export async function registerForPush(onToken: (token: string) => void): Promise<Handle | null> {
  if (!hasPlugin('PushNotifications') || !(await pushConfigured())) return null;
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') return null;
  const h = await PushNotifications.addListener('registration', (t) => onToken(t.value));
  await PushNotifications.register();
  return h;
}

/** Messages that arrive while the app is open, and taps on ones that arrived while it was not. */
export async function onPushMessage(
  fn: (m: PushMessage, opened: boolean) => void,
): Promise<Handle | null> {
  if (!hasPlugin('PushNotifications')) return null;
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const read = (data: Record<string, unknown> | undefined): PushMessage => ({
    kind: (['inbox', 'reminder', 'sync'] as const).find((k) => k === data?.['kind']) ?? 'sync',
    ...(data?.['count'] ? { count: Number(data['count']) } : {}),
  });
  const a = await PushNotifications.addListener('pushNotificationReceived', (n) =>
    fn(read(n.data as Record<string, unknown>), false),
  );
  const b = await PushNotifications.addListener('pushNotificationActionPerformed', (n) =>
    fn(read(n.notification.data as Record<string, unknown>), true),
  );
  return {
    remove: async () => {
      await a.remove();
      await b.remove();
    },
  };
}

import { isDesktop } from './bridge';
import { inboxNotice } from './logic';

/**
 * A native notification when the checks raised new inbox items (desktop only). It asks for permission
 * the first time; if the person says no, nothing is shown and nothing is asked again by this code.
 */
export async function notifyInbox(
  created: number,
  byKind: Record<string, number>,
  say: (count: number) => string,
): Promise<void> {
  if (!isDesktop() || !inboxNotice(created, byKind)) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } =
      await import('@tauri-apps/plugin-notification');
    const granted = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title: 'GST Desk', body: say(created) });
  } catch (e) {
    console.warn('could not show a notification', e);
  }
}

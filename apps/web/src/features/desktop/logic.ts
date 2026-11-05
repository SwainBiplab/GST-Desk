/** Desktop rules that need no desktop to test: when to look for an update, which channel, and what a link may open. */

const DAY = 24 * 3_600_000;

export type Channel = 'stable' | 'beta';
export const CHANNEL_KEY = 'gst.update.channel';
export const LAST_CHECK_KEY = 'gst.update.lastCheck';

/** Check on launch, and then once a day while the app stays open. */
export function updateDue(lastCheck: number | null, now: number, onLaunch: boolean): boolean {
  if (onLaunch) return true;
  return lastCheck === null || now - lastCheck >= DAY;
}

export function readChannel(read: (k: string) => string | null): Channel {
  return read(CHANNEL_KEY) === 'beta' ? 'beta' : 'stable';
}

export const readLastCheck = (read: (k: string) => string | null): number | null => {
  const n = Number(read(LAST_CHECK_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * A `gstdesk://` link to the route it opens, or null. Only a short list of places can be opened, so a
 * link in an email or on a web page cannot reach anything else in the app.
 *
 * - `gstdesk://inbox`, `gstdesk://dashboard`, `gstdesk://reports`
 * - `gstdesk://new-bill` (the sell screen in Shop, a new tax invoice in Books)
 * - `gstdesk://settings/backup`
 */
export function routeForLink(
  url: string,
  shell: 'shop' | 'books',
): { to: string; search?: Record<string, unknown> } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'gstdesk:') return null;
  // `gstdesk://inbox` parses with "inbox" as the host; `gstdesk:///inbox` and `gstdesk:inbox` as the path
  const parts = [u.host, ...u.pathname.split('/')].filter(Boolean).map((p) => p.toLowerCase());
  const [first, second] = parts;
  switch (first) {
    case 'inbox':
    case 'dashboard':
    case 'reports':
      return { to: `/${shell}/${first}` };
    case 'new-bill':
      return shell === 'shop'
        ? { to: '/shop/sell' }
        : { to: '/books/documents/new', search: { type: 'tax_invoice' } };
    case 'settings':
      return second === 'backup'
        ? { to: `/${shell}/settings`, search: { tab: 'backup' } }
        : { to: `/${shell}/settings` };
    default:
      return null;
  }
}

/** What a native notification says when the checks raised new inbox items; null when there is nothing to say. */
export function inboxNotice(
  created: number,
  byKind: Record<string, number>,
): { count: number; kinds: string[] } | null {
  if (created <= 0) return null;
  const kinds = Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .slice(0, 3);
  return { count: created, kinds };
}

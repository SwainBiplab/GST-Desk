import { describe, expect, it } from 'vitest';

import { inboxNotice, readChannel, readLastCheck, routeForLink, updateDue } from './logic';

const DAY = 86_400_000;

describe('when to look for an update', () => {
  it('always on launch, then once a day', () => {
    expect(updateDue(null, 1000, true)).toBe(true);
    expect(updateDue(Date.now(), Date.now() + 1000, true)).toBe(true);
    expect(updateDue(null, 1000, false)).toBe(true);
    expect(updateDue(1000, 1000 + DAY - 1, false)).toBe(false);
    expect(updateDue(1000, 1000 + DAY, false)).toBe(true);
  });

  it('reads the channel, defaulting to stable', () => {
    expect(readChannel(() => 'beta')).toBe('beta');
    expect(readChannel(() => 'stable')).toBe('stable');
    expect(readChannel(() => 'nightly')).toBe('stable');
    expect(readChannel(() => null)).toBe('stable');
  });

  it('reads the last check, ignoring nonsense', () => {
    expect(readLastCheck(() => '1700000000000')).toBe(1_700_000_000_000);
    expect(readLastCheck(() => 'abc')).toBeNull();
    expect(readLastCheck(() => null)).toBeNull();
    expect(readLastCheck(() => '-5')).toBeNull();
  });
});

describe('gstdesk:// links', () => {
  it('opens the pages on the short list, in the current mode', () => {
    expect(routeForLink('gstdesk://inbox', 'books')).toEqual({ to: '/books/inbox' });
    expect(routeForLink('gstdesk://inbox', 'shop')).toEqual({ to: '/shop/inbox' });
    expect(routeForLink('gstdesk://Dashboard', 'shop')).toEqual({ to: '/shop/dashboard' });
    expect(routeForLink('gstdesk://reports', 'books')).toEqual({ to: '/books/reports' });
    expect(routeForLink('gstdesk://new-bill', 'shop')).toEqual({ to: '/shop/sell' });
    expect(routeForLink('gstdesk://new-bill', 'books')).toEqual({
      to: '/books/documents/new',
      search: { type: 'tax_invoice' },
    });
    expect(routeForLink('gstdesk://settings/backup', 'books')).toEqual({
      to: '/books/settings',
      search: { tab: 'backup' },
    });
    expect(routeForLink('gstdesk://settings', 'shop')).toEqual({ to: '/shop/settings' });
  });

  it('opens nothing else', () => {
    for (const bad of [
      'https://inbox',
      'gstdesk://',
      'gstdesk://delete-everything',
      'gstdesk://parties/../../x',
      'javascript:alert(1)',
      'not a url',
      '',
    ])
      expect(routeForLink(bad, 'books'), bad).toBeNull();
  });
});

describe('the inbox notice', () => {
  it('names how many, and the biggest kinds', () => {
    expect(inboxNotice(0, {})).toBeNull();
    expect(inboxNotice(-1, {})).toBeNull();
    expect(
      inboxNotice(12, { reminder_due: 8, low_stock: 3, draft_stale: 1, rate_change: 0 }),
    ).toEqual({ count: 12, kinds: ['reminder_due', 'low_stock', 'draft_stale'] });
  });
});

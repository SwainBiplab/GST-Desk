import { describe, expect, it } from 'vitest';

import { SCREEN_IDS, screenFor, search, type Article } from './model';

const articles: Article[] = [
  {
    id: 'start',
    title: 'Getting started',
    paragraphs: ['Make a backup in Settings.', 'Add a party.'],
  },
  {
    id: 'parties',
    title: 'Parties',
    paragraphs: ['Customers and suppliers.', 'Merge duplicates.'],
  },
  { id: 'settings', title: 'Settings', paragraphs: ['Backup is where you back up and restore.'] },
];

describe('help search', () => {
  it('lists everything for an empty query', () => {
    expect(search(articles, '')).toHaveLength(3);
    expect(search(articles, '   ')).toHaveLength(3);
  });

  it('finds an article by a word in its title or its text', () => {
    expect(search(articles, 'backup').map((a) => a.id)).toEqual(['start', 'settings']);
    expect(search(articles, 'parties').map((a) => a.id)).toEqual(['parties']);
    expect(search(articles, 'duplicates').map((a) => a.id)).toEqual(['parties']);
  });

  it('needs every word, ignores case and accents, and can find nothing', () => {
    expect(search(articles, 'BACKUP restore').map((a) => a.id)).toEqual(['settings']);
    expect(search(articles, 'Café backup')).toEqual([]);
    expect(search(articles, 'zzz')).toEqual([]);
  });

  it('works on Indian-script text too', () => {
    const hi: Article[] = [{ id: 'start', title: 'शुरुआत कैसे करें', paragraphs: ['बैकअप बनाएँ'] }];
    expect(search(hi, 'बैकअप')).toHaveLength(1);
    expect(search(hi, 'चालान')).toHaveLength(0);
  });
});

describe('help for a screen', () => {
  it('has an article for every screen and none for pages without one', () => {
    for (const id of SCREEN_IDS) expect(screenFor(id)).toBe(id);
    expect(screenFor('welcome')).toBeNull();
    expect(screenFor(null)).toBeNull();
    expect(screenFor(undefined)).toBeNull();
    expect(screenFor('')).toBeNull();
  });
});

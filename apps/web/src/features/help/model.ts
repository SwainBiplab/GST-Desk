/** What the help dialog lists and how it searches. Pure, so it is unit tested. */

export const SCREEN_IDS = [
  'dashboard',
  'sell',
  'documents',
  'parties',
  'items',
  'payments',
  'reports',
  'inbox',
  'settings',
] as const;
export type ScreenId = (typeof SCREEN_IDS)[number];

export const START_STEPS = ['s1', 's2', 's3', 's4', 's5', 's6'] as const;

export interface Article {
  /** `start` for the guide, otherwise a screen id. */
  id: string;
  title: string;
  /** Everything the article says, one paragraph per entry (searched, and shown). */
  paragraphs: string[];
}

/** The help article for the screen a page shows, or null for a page with none. */
export function screenFor(page: string | null | undefined): ScreenId | null {
  return (SCREEN_IDS as readonly string[]).includes(page ?? '') ? (page as ScreenId) : null;
}

/** Every word typed must appear somewhere in the title or the text; case and accents are ignored. */
export function search(articles: readonly Article[], query: string): Article[] {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...articles];
  return articles.filter((a) => {
    const hay = norm([a.title, ...a.paragraphs].join(' '));
    return words.every((w) => hay.includes(w));
  });
}

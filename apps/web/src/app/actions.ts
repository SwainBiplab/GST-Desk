/**
 * Action registry for the command bar. Features register actions; the command bar filters and runs them.
 * This file is pure (no React, no DOM) so the filtering rules are unit-testable.
 */
import type { Shell } from './store';

export interface ActionContext {
  shell: Shell | null;
  businessId: string | null;
  navigate: (to: string, search?: Record<string, unknown>) => void;
  /** Open another UI surface (command bar prefilled, shortcut sheet, ...). */
  ui: {
    openCommandBar: (prefill?: string) => void;
    openKeymap: () => void;
    toggleTheme: () => void;
    toggleDensity: () => void;
    switchShell: (shell: Shell) => void;
    loadDemoData: () => Promise<void>;
  };
}

export interface Action {
  /** Stable id, e.g. `nav.parties`. */
  id: string;
  title: string;
  /** Group heading in the command bar: Go to, New, Settings... */
  section: string;
  /** Display-only hint, e.g. `G then P`. */
  shortcut?: string;
  keywords?: string[];
  run: (ctx: ActionContext) => void | Promise<void>;
  /** Hide the action when this returns false. */
  when?: (ctx: ActionContext) => boolean;
}

const registry = new Map<string, Action>();
const listeners = new Set<() => void>();

/** Register (or replace) an action. Returns a function that removes it. */
export function registerAction(action: Action): () => void {
  registry.set(action.id, action);
  listeners.forEach((l) => l());
  return () => {
    if (registry.get(action.id) === action) registry.delete(action.id);
    listeners.forEach((l) => l());
  };
}

export function getActions(ctx?: ActionContext): Action[] {
  const all = [...registry.values()];
  return ctx ? all.filter((a) => !a.when || a.when(ctx)) : all;
}

export function getAction(id: string): Action | undefined {
  return registry.get(id);
}

export function subscribeActions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test helper. */
export function clearActions(): void {
  registry.clear();
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Is `needle` a subsequence of `hay` ("npar" matches "new party")? */
function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
}

/**
 * Score an action for a query; higher is better, 0 means no match. Every query word must match
 * somewhere (title, keywords or section). Title prefixes beat word prefixes beat keywords beat fuzzy.
 */
export function scoreAction(action: Action, query: string): number {
  const q = norm(query);
  if (!q) return 1;
  const title = norm(action.title);
  const section = norm(action.section);
  const keywords = (action.keywords ?? []).map(norm);
  let total = 0;
  for (const word of q.split(' ')) {
    let best = 0;
    if (title.startsWith(word)) best = 100;
    else if (title.split(' ').some((w) => w.startsWith(word))) best = 80;
    else if (keywords.some((k) => k.split(' ').some((w) => w.startsWith(word)))) best = 60;
    else if (section.startsWith(word)) best = 40;
    else if (title.includes(word)) best = 30;
    else if (word.length >= 3 && subsequence(word, title.replace(/ /g, ''))) best = 10;
    if (best === 0) return 0;
    total += best;
  }
  return total + (title.startsWith(q) ? 50 : 0);
}

/** Actions matching `query`, best first. `recent` ids float to the top when the query is empty. */
export function filterActions(
  actions: Action[],
  query: string,
  opts: { recent?: string[]; limit?: number } = {},
): Action[] {
  const recent = opts.recent ?? [];
  const scored = actions
    .map((a, i) => ({
      a,
      i,
      s: scoreAction(a, query),
      r: recent.indexOf(a.id),
    }))
    .filter((x) => x.s > 0);
  scored.sort((x, y) => {
    if (!query.trim()) {
      const rx = x.r < 0 ? 99 : x.r;
      const ry = y.r < 0 ? 99 : y.r;
      if (rx !== ry) return rx - ry;
      return x.i - y.i;
    }
    return y.s - x.s || x.i - y.i;
  });
  return scored.slice(0, opts.limit ?? 50).map((x) => x.a);
}

/* ------------------------------------------------------------------ recents */

const RECENT_KEY = 'gst.recentActions';

export function readRecentActions(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function pushRecentAction(id: string, max = 6): string[] {
  const next = [id, ...readRecentActions().filter((x) => x !== id)].slice(0, max);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

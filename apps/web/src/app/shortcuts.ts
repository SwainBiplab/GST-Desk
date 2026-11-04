/** Single source for keyboard shortcuts: drives the hotkey handler, the in-app map and docs/keyboard.md. */
import type { Shell } from './store';

export interface Shortcut {
  keys: string;
  description: string;
  /** Where it works: both shells or only Books. */
  scope: 'global' | 'books';
}

/** `G then <key>` go-to targets in Books. */
export const GO_TO: Record<string, { page: string; label: string }> = {
  h: { page: 'dashboard', label: 'Dashboard' },
  d: { page: 'documents', label: 'Documents' },
  p: { page: 'parties', label: 'Parties' },
  i: { page: 'items', label: 'Items' },
  r: { page: 'reports', label: 'Reports' },
  m: { page: 'payments', label: 'Money (payments)' },
  b: { page: 'inbox', label: 'Inbox' },
  s: { page: 'settings', label: 'Settings' },
};

export const SHORTCUTS: Shortcut[] = [
  { keys: 'Ctrl+K', description: 'Open the command bar', scope: 'global' },
  { keys: '/', description: 'Open the command bar (when not typing in a field)', scope: 'global' },
  { keys: '?', description: 'Show this keyboard map', scope: 'global' },
  { keys: 'Esc', description: 'Close the command bar or a dialog', scope: 'global' },
  { keys: 'N', description: 'New document menu', scope: 'books' },
  ...Object.entries(GO_TO).map(([k, v]) => ({
    keys: `G then ${k.toUpperCase()}`,
    description: `Go to ${v.label}`,
    scope: 'books' as const,
  })),
];

export const shortcutsFor = (shell: Shell | null) =>
  SHORTCUTS.filter((s) => s.scope === 'global' || shell === 'books');

/** True when the key event target is somewhere the user is typing. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.getAttribute('role') === 'combobox'
  );
}

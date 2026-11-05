import { useSyncExternalStore } from 'react';

/** Whether the help dialog is open, and which article it starts on. */
interface HelpState {
  open: boolean;
  article: string | null;
}

let state: HelpState = { open: false, article: null };
const listeners = new Set<() => void>();
const set = (next: HelpState) => {
  state = next;
  listeners.forEach((l) => l());
};

export const openHelp = (article: string | null = null) => set({ open: true, article });
export const closeHelp = () => set({ open: false, article: null });

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useHelp = (): HelpState =>
  useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );

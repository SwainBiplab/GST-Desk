import { create } from 'zustand';

import { rememberFocus } from './focus';

export type Shell = 'shop' | 'books';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode): the choice just will not persist */
  }
};

/** Last shell used on this device. */
export const lastShell = (): Shell => (read('gst.shell') === 'books' ? 'books' : 'shop');

export function deviceId(): string {
  let id = read('gst.device');
  if (!id) {
    id = crypto.randomUUID();
    write('gst.device', id);
  }
  return id;
}

interface AppState {
  businessId: string | null;
  setBusinessId: (id: string | null) => void;
  shell: Shell;
  setShell: (s: Shell) => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean, prefill?: string) => void;
  commandPrefill: string;
  keymapOpen: boolean;
  setKeymapOpen: (open: boolean) => void;
  /** Bumped when density changes so labels re-render. */
  densityTick: number;
  bumpDensity: () => void;
  /** Width in px of the Books right panel. */
  panelWidth: number;
  setPanelWidth: (w: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  businessId: read('gst.business'),
  setBusinessId: (businessId) => {
    if (businessId) write('gst.business', businessId);
    set({ businessId });
  },
  shell: lastShell(),
  setShell: (shell) => {
    write('gst.shell', shell);
    set({ shell });
  },
  commandOpen: false,
  commandPrefill: '',
  setCommandOpen: (commandOpen, prefill = '') => {
    if (commandOpen) rememberFocus();
    set({ commandOpen, commandPrefill: prefill });
  },
  keymapOpen: false,
  setKeymapOpen: (keymapOpen) => {
    if (keymapOpen) rememberFocus();
    set({ keymapOpen });
  },
  densityTick: 0,
  bumpDensity: () => set((s) => ({ densityTick: s.densityTick + 1 })),
  panelWidth: Number(read('gst.panel')) || 360,
  setPanelWidth: (panelWidth) => {
    write('gst.panel', String(panelWidth));
    set({ panelWidth });
  },
}));

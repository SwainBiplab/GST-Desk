import { useMemo } from 'react';

import type { ActionContext } from './actions';
import { toggleDensity } from './components/chrome';
import { useAppDb } from './db';
import { useAppNavigate, useLocationInfo } from './hooks';
import { useAppStore, type Shell } from './store';

import { useFeatureFlags } from '@/features/business/hooks';

/** Toggle light/dark the same way `ThemeToggle` does, so both stay in sync and persist. */
export function toggleTheme() {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try {
    localStorage.setItem('data-theme', next);
  } catch {
    /* ignore */
  }
}

/** Everything an action may need, built from the current route and stores. */
export function useActionContext(): ActionContext {
  const navigate = useAppNavigate();
  const flags = useFeatureFlags();
  const { shell, page } = useLocationInfo();
  const { ctx, loadDemoData } = useAppDb();
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const setKeymapOpen = useAppStore((s) => s.setKeymapOpen);
  const setShell = useAppStore((s) => s.setShell);
  const stored = useAppStore((s) => s.shell);

  return useMemo<ActionContext>(
    () => ({
      shell,
      businessId: ctx?.businessId ?? null,
      flags,
      navigate,
      ui: {
        openCommandBar: (prefill) => setCommandOpen(true, prefill ?? ''),
        openKeymap: () => setKeymapOpen(true),
        toggleTheme,
        toggleDensity: () => toggleDensity(shell ?? stored),
        switchShell: (s: Shell) => {
          setShell(s);
          navigate(`/${s}/${page ?? 'dashboard'}`);
        },
        loadDemoData,
      },
    }),
    [
      shell,
      page,
      stored,
      ctx?.businessId,
      flags,
      navigate,
      setCommandOpen,
      setKeymapOpen,
      setShell,
      loadDemoData,
    ],
  );
}

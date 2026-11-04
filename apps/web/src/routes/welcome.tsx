import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { useAppDb } from '@/app/db';
import { useAppStore } from '@/app/store';
import { Wizard } from '@/features/onboarding/wizard';

export const Route = createFileRoute('/welcome')({
  validateSearch: (s: Record<string, unknown>): { add?: true } =>
    s['add'] === true || s['add'] === 'true' || s['add'] === '1' || s['add'] === 1
      ? { add: true }
      : {},
  component: function Welcome() {
    const { add } = Route.useSearch();
    const { businessesReady, businesses } = useAppDb();
    const navigate = useNavigate();
    const shell = useAppStore((s) => s.shell);
    // Decide once, when the data first loads: someone who already has a business and did not ask to
    // add one belongs on the dashboard. Creating a business later must not trigger this.
    const decided = useRef<'stay' | 'leave' | null>(null);
    useEffect(() => {
      if (!businessesReady || decided.current) return;
      decided.current = businesses.length > 0 && !add ? 'leave' : 'stay';
      if (decided.current === 'leave') {
        void navigate({
          to: shell === 'books' ? '/books/$page' : '/shop/$page',
          params: { page: 'dashboard' },
          replace: true,
        });
      }
    }, [businessesReady, businesses.length, add, navigate, shell]);
    return <Wizard addMode={!!add} />;
  },
});

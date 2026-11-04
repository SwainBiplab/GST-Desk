import { createFileRoute, redirect } from '@tanstack/react-router';

import { lastShell } from '@/app/store';

/** Open the shell this device used last. */
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({
      to: lastShell() === 'books' ? '/books/$page' : '/shop/$page',
      params: { page: 'dashboard' },
    });
  },
});

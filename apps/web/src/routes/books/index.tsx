import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/books/')({
  beforeLoad: () => {
    throw redirect({ to: '/books/$page', params: { page: 'dashboard' } });
  },
});

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/shop/')({
  beforeLoad: () => {
    throw redirect({ to: '/shop/$page', params: { page: 'dashboard' } });
  },
});

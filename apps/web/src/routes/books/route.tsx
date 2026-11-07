import { createFileRoute, redirect } from '@tanstack/react-router';

import { BooksLayout } from '@/app/components/layouts';
import { isMobileLayout } from '@/platform';

/** Books is a desktop layout: on a phone every Books address opens the same page in the phone layout. */
export const Route = createFileRoute('/books')({
  beforeLoad: ({ location }) => {
    if (isMobileLayout())
      throw redirect({ href: location.href.replace(/^\/books(\/documents\/new)?/, '/shop') });
  },
  component: BooksLayout,
});

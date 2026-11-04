import { createFileRoute, notFound } from '@tanstack/react-router';

import { PlaceholderPage } from '@/app/components/dashboard';
import { isPageId } from '@/app/nav';

export const Route = createFileRoute('/books/$page')({
  validateSearch: (s: Record<string, unknown>) => s,
  beforeLoad: ({ params }) => {
    if (!isPageId(params.page)) throw notFound();
  },
  component: function BooksPage() {
    const { page } = Route.useParams();
    return isPageId(page) ? <PlaceholderPage page={page} shell="books" /> : null;
  },
});

import { createFileRoute, notFound } from '@tanstack/react-router';

import { PlaceholderPage } from '@/app/components/dashboard';
import { isPageId } from '@/app/nav';

export const Route = createFileRoute('/shop/$page')({
  validateSearch: (s: Record<string, unknown>) => s,
  beforeLoad: ({ params }) => {
    if (!isPageId(params.page)) throw notFound();
  },
  component: function ShopPage() {
    const { page } = Route.useParams();
    return isPageId(page) ? <PlaceholderPage page={page} shell="shop" /> : null;
  },
});

import { createFileRoute, notFound } from '@tanstack/react-router';

import { PlaceholderPage } from '@/app/components/dashboard';
import { useLocationInfo } from '@/app/hooks';
import { isPageId } from '@/app/nav';
import { AccountScreen } from '@/features/mobile/account';
import { MobileBillRoute } from '@/features/mobile/bill';
import { MobileHome } from '@/features/mobile/home';
import { MobileMore } from '@/features/mobile/more';
import { isMobileLayout } from '@/platform';

export const Route = createFileRoute('/shop/$page')({
  validateSearch: (s: Record<string, unknown>) => s,
  beforeLoad: ({ params }) => {
    if (!isPageId(params.page)) throw notFound();
  },
  component: function ShopPage() {
    const { page } = Route.useParams();
    const { search } = useLocationInfo();
    if (!isPageId(page)) return null;
    // the phone layout has its own home, bill and More; the other pages are the shop's
    if (isMobileLayout()) {
      if (page === 'dashboard') return <MobileHome />;
      if (page === 'sell') return <MobileBillRoute />;
      if (page === 'settings' && search['screen'] === 'account') return <AccountScreen />;
      if (page === 'settings' && search['full'] !== '1') return <MobileMore />;
    }
    return <PlaceholderPage page={page} shell="shop" />;
  },
});

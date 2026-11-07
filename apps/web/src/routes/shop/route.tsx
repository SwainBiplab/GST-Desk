import { createFileRoute } from '@tanstack/react-router';

import { ShopLayout } from '@/app/components/layouts';
import { MobileLayout } from '@/features/mobile/layout';
import { isMobileLayout } from '@/platform';

/** The shop shell: on a phone (the app, or a narrow touch screen) it is the phone layout. */
export const Route = createFileRoute('/shop')({
  component: function Shop() {
    return isMobileLayout() ? <MobileLayout /> : <ShopLayout />;
  },
});

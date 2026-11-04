import { createFileRoute } from '@tanstack/react-router';

import { ShopLayout } from '@/app/components/layouts';

export const Route = createFileRoute('/shop')({ component: ShopLayout });

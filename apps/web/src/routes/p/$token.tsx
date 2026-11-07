import { createFileRoute } from '@tanstack/react-router';

import { PortalPage } from '@/features/portal/portal-page';

/** A customer's link (prompt 47): one invoice or one statement, no sign-in, no local book. */
export const Route = createFileRoute('/p/$token')({
  validateSearch: (s: Record<string, unknown>): { api?: string } =>
    typeof s['api'] === 'string' ? { api: s['api'] } : {},
  component: function Portal() {
    const { token } = Route.useParams();
    return <PortalPage token={token} />;
  },
});

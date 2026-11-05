import { Toaster, TooltipProvider } from '@gst/ui';
import { Link, Outlet, createRootRoute, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorBoundary, RouteError } from '@/app/components/boundary';
import { CommandBar } from '@/app/components/command-bar';
import { ConfirmProvider } from '@/app/components/confirm';
import { Hotkeys, KeymapDialog } from '@/app/components/keymap';
import { UpdateBar } from '@/app/components/update-bar';
import { AppDbProvider, DEMO_REQUESTED, useAppDb } from '@/app/db';
import { registerDefaultActions } from '@/app/default-actions';
import { lastShell } from '@/app/store';
import { BackgroundJobs } from '@/features/data/background';
import { InboxJobs } from '@/features/inbox/jobs';

registerDefaultActions();

function NotFound() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto mt-16 max-w-md p-6 text-center">
      <h1 className="text-xl font-semibold">{t('page.unknown')}</h1>
      <p className="py-3">
        <Link
          to={`/${lastShell()}/$page` as '/shop/$page'}
          params={{ page: 'dashboard' }}
          className="underline"
        >
          {t('page.back')}
        </Link>
      </p>
    </div>
  );
}

/** With no business yet, the only useful place is the setup wizard. */
function FirstRunGuard() {
  const { status, businessesReady, businesses } = useAppDb();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  useEffect(() => {
    if (status !== 'ready' || !businessesReady || businesses.length > 0 || DEMO_REQUESTED) return;
    if (!pathname.startsWith('/welcome')) void navigate({ to: '/welcome', replace: true });
  }, [status, businessesReady, businesses.length, pathname, navigate]);
  return null;
}

function Root() {
  return (
    <AppDbProvider>
      <ConfirmProvider>
        <TooltipProvider>
          <FirstRunGuard />
          <BackgroundJobs />
          <InboxJobs />
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
          <CommandBar />
          <KeymapDialog />
          <Hotkeys />
          <UpdateBar />
          <Toaster />
        </TooltipProvider>
      </ConfirmProvider>
    </AppDbProvider>
  );
}

export const Route = createRootRoute({
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

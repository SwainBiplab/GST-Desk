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
import { AiJobs } from '@/features/ai/ai-jobs';
import { BackgroundJobs } from '@/features/data/background';
import { DesktopJobs } from '@/features/desktop/desktop-jobs';
import { GspJobs } from '@/features/einvoice/jobs';
import { HelpDialog } from '@/features/help/help-dialog';
import { InboxJobs } from '@/features/inbox/jobs';
import { LanJobs } from '@/features/lan/lan-jobs';
import { LedgerJobs } from '@/features/ledger/jobs';
import { SyncDevHooks } from '@/features/sync/dev-hooks';
import { SyncJobs } from '@/features/sync/sync-jobs';
import { PermissionsSource } from '@/features/team/source';
import { TelemetryJobs } from '@/features/telemetry/jobs';
import i18n, { i18nReady } from '@/lib/i18n';

registerDefaultActions();
// the titles are in the language of the screens: write them again once it is loaded, and when it changes
void i18nReady.then(registerDefaultActions);
i18n.on('languageChanged', registerDefaultActions);

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
  const { status, businessesReady, businesses, cloudBook } = useAppDb();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const screen = useRouterState({
    select: (s): string | null => {
      const v = (s.location.search as Record<string, unknown>)['screen'];
      return typeof v === 'string' ? v : null;
    },
  });
  const navigate = useNavigate();
  useEffect(() => {
    // a synced book has no business until the first download lands: the phone layout shows that
    if (
      status !== 'ready' ||
      !businessesReady ||
      businesses.length > 0 ||
      DEMO_REQUESTED ||
      cloudBook
    )
      return;
    // the phone's account screen signs in to a business that syncs down: no local business needed;
    // a customer's page (prompt 47) is not this device's book at all
    if (
      pathname.startsWith('/welcome') ||
      pathname.startsWith('/p/') ||
      (pathname === '/shop/settings' && screen === 'account')
    )
      return;
    void navigate({ to: '/welcome', replace: true });
  }, [status, businessesReady, businesses.length, pathname, screen, navigate, cloudBook]);
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
          <GspJobs />
          <DesktopJobs />
          <LanJobs />
          <LedgerJobs />
          <AiJobs />
          <SyncDevHooks />
          <SyncJobs />
          <PermissionsSource />
          <TelemetryJobs />
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
          <CommandBar />
          <KeymapDialog />
          <HelpDialog />
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

import { Toaster, TooltipProvider } from '@gst/ui';
import { Link, Outlet, createRootRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { ErrorBoundary, RouteError } from '@/app/components/boundary';
import { CommandBar } from '@/app/components/command-bar';
import { ConfirmProvider } from '@/app/components/confirm';
import { Hotkeys, KeymapDialog } from '@/app/components/keymap';
import { UpdateBar } from '@/app/components/update-bar';
import { AppDbProvider } from '@/app/db';
import { registerDefaultActions } from '@/app/default-actions';
import { lastShell } from '@/app/store';

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

function Root() {
  return (
    <AppDbProvider>
      <ConfirmProvider>
        <TooltipProvider>
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

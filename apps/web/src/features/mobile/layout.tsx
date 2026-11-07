/**
 * The phone layout (prompt 43, UX-11): one hand, bottom tabs (Home, Bill, Parties, Inbox, More), big
 * targets, the business and sync state in a thin header, pull to refresh on every list, the app lock,
 * and the hardware back button. It is the shop shell's pages on a phone: `/shop/...` addresses work the
 * same, so every link in the app lands here.
 */
import { Badge, cn } from '@gst/ui';
import { Inbox, LayoutDashboard, Menu, ShoppingCart, Users, type LucideProps } from '@gst/ui/icons';
import { Link, Outlet } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { AppLock } from './app-lock';
import { InitialSync } from './initial-sync';
import { TABS, TAB_PAGE, tabFor, type Tab } from './logic';
import { PullToRefresh } from './pull-to-refresh';

import { SyncPill } from '@/app/components/chrome';
import { useAppDb } from '@/app/db';
import { useCounts, useLocationInfo } from '@/app/hooks';
import { useAppStore } from '@/app/store';
import { dyn } from '@/lib/dyn-key';
import { isNativeApp } from '@/platform';
import { onBackButton, readyForDisplay } from '@/platform/app';

const ICON: Record<Tab, ComponentType<LucideProps>> = {
  home: LayoutDashboard,
  bill: ShoppingCart,
  parties: Users,
  inbox: Inbox,
  more: Menu,
};

export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

export function MobileLayout() {
  const { t } = useTranslation();
  const { business, businesses, cloudBook, status, error } = useAppDb();
  const setShell = useAppStore((s) => s.setShell);
  const { page } = useLocationInfo();
  const tab = tabFor(page);
  const counts = useCounts();
  const online = useOnline();

  useEffect(() => {
    setShell('shop');
    const root = document.documentElement;
    root.setAttribute('data-layout', 'mobile');
    root.setAttribute('data-density', 'comfortable');
    void readyForDisplay();
    return () => root.removeAttribute('data-layout');
  }, [setShell]);

  // the phone's accessibility tree (what Maestro and TalkBack see) carries HTML ids, not test ids:
  // in the app, every element with a test id gets the same id, so the flows can name them
  useEffect(() => {
    if (!isNativeApp()) return;
    const mirror = (root: ParentNode) => {
      for (const el of root.querySelectorAll<HTMLElement>('[data-testid]:not([id])'))
        el.id = el.dataset['testid'] ?? '';
    };
    mirror(document);
    const mo = new MutationObserver((muts) => {
      for (const m of muts)
        for (const n of m.addedNodes) if (n instanceof HTMLElement) mirror(n.parentNode ?? n);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  // the back button goes back inside the app; from Home it leaves the app
  const back = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    void onBackButton(() => {
      if (window.history.length > 1 && tab !== 'home') {
        window.history.back();
        return true;
      }
      return false;
    }).then((o) => (back.current = o));
    return () => void back.current?.();
  }, [tab]);

  const waiting = cloudBook && status === 'ready' && businesses.length === 0;

  return (
    <div
      className="flex h-dvh flex-col bg-bg"
      data-shell="mobile"
      data-testid="mobile-layout"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="mobile-business">
          {business
            ? String(business['trade_name'] || business['legal_name'])
            : t('mobile.noBusiness')}
        </span>
        {!online && (
          <Badge tone="warning" data-testid="mobile-offline">
            {t('mobile.offline')}
          </Badge>
        )}
        <SyncPill />
      </header>
      {status === 'error' ? (
        <div className="p-6 text-sm" role="alert" data-testid="mobile-db-error">
          <p className="font-medium">{t('mobile.dbError')}</p>
          <p className="pt-2 text-fg-muted">{error?.message}</p>
        </div>
      ) : waiting ? (
        <InitialSync />
      ) : (
        <PullToRefresh>
          <main id="main" tabIndex={-1} className="p-3 pb-6 outline-none">
            <Outlet />
          </main>
        </PullToRefresh>
      )}
      <nav
        aria-label={t('nav.label')}
        className="grid grid-cols-5 border-t border-border bg-surface-1"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {TABS.map((k) => {
          const Icon = ICON[k];
          const active = k === tab;
          const badge = k === 'inbox' ? counts?.reviewPending : undefined;
          return (
            <Link
              key={k}
              to="/shop/$page"
              params={{ page: TAB_PAGE[k] }}
              {...(k === 'bill' ? { search: { type: 'tax_invoice' } as never } : {})}
              aria-current={active ? 'page' : undefined}
              data-testid={`tab-${k}`}
              className={cn(
                'relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px]',
                active ? 'text-accent' : 'text-fg-muted',
              )}
            >
              <Icon size={22} aria-hidden />
              {t(dyn(`mobile.tabs.${k}`))}
              {!!badge && (
                <span className="absolute right-4 top-1.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold text-danger-fg">
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <AppLock />
    </div>
  );
}

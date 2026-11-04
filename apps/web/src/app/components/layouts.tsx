import { Button, formatPaise } from '@gst/ui';
import { Link, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppDb } from '../db';
import { useLocationInfo, useTodaySummary } from '../hooks';
import { BOOKS_NAV, SHOP_NAV } from '../nav';
import { useAppStore, type Shell } from '../store';

import { BusinessSwitcher, ChromeControls, applyDensity } from './chrome';
import { NavEntry } from './nav';
import { RightPanel, RightPanelProvider } from './panel';

function useShell(shell: Shell) {
  const setShell = useAppStore((s) => s.setShell);
  useEffect(() => {
    setShell(shell);
    applyDensity(shell);
  }, [shell, setShell]);
}

function SkipLink() {
  const { t } = useTranslation();
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-(--z-toast) focus:rounded-md focus:bg-bg focus:p-2"
    >
      {t('app.skip')}
    </a>
  );
}

function Strip() {
  const { t } = useTranslation();
  const s = useTodaySummary();
  const cell = (label: string, value: number | undefined, id: string) => (
    <div className="flex items-baseline gap-2" data-testid={id}>
      <span className="text-fg-muted">{label}</span>
      <span className="tabular text-lg font-semibold">
        {value === undefined ? '—' : formatPaise(value)}
      </span>
    </div>
  );
  return (
    <footer
      data-testid="summary-strip"
      className="flex flex-wrap items-center justify-around gap-x-6 border-t border-border bg-surface-1 px-4 py-2"
    >
      {cell(t('strip.sales'), s?.salesPaise, 'strip-sales')}
      {cell(t('strip.cash'), s?.cashReceivedPaise, 'strip-cash')}
      {cell(t('strip.pending'), s?.pendingPaise, 'strip-pending')}
    </footer>
  );
}

/** Shop: big actions, icon rail, comfortable density, 44 px targets, today strip at the bottom. */
export function ShopLayout() {
  const { t } = useTranslation();
  useShell('shop');
  const { business } = useAppDb();
  return (
    <div className="flex h-screen flex-col" data-shell="shop">
      <SkipLink />
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
        <BusinessSwitcher large />
        <span className="sr-only">{business ? '' : t('chrome.noBusiness')}</span>
        <div className="flex items-center gap-2">
          <Button asChild className="min-h-11 px-4 text-base">
            <Link to="/shop/$page" params={{ page: 'sell' }} data-testid="action-new-bill">
              {t('actions.newBill')}
            </Link>
          </Button>
          <Button asChild variant="outline" className="min-h-11 px-4 text-base">
            <Link to="/shop/$page" params={{ page: 'payments' }} search={{ intent: 'receive' }}>
              {t('actions.receivePayment')}
            </Link>
          </Button>
          <Button asChild variant="outline" className="min-h-11 px-4 text-base">
            <Link to="/shop/$page" params={{ page: 'inbox' }} search={{ intent: 'scan' }}>
              {t('actions.scanBill')}
            </Link>
          </Button>
        </div>
        <div className="ml-auto">
          <ChromeControls shell="shop" />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t('nav.label')}
          className="flex w-16 shrink-0 flex-col items-center gap-1 overflow-auto border-r border-border p-1"
        >
          {SHOP_NAV.map((item) => (
            <NavEntry key={item.id} shell="shop" item={item} compact />
          ))}
        </nav>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-auto p-4 outline-none">
          <Outlet />
        </main>
      </div>
      <Strip />
    </div>
  );
}

function Breadcrumb() {
  const { t } = useTranslation();
  const { page, search } = useLocationInfo();
  const crumbs = [t('shell.books')];
  if (page) {
    const sectionKey =
      search['kind'] === 'purchases' ? 'purchases' : search['section'] === 'gst' ? 'gst' : null;
    if (sectionKey) crumbs.push(t(`nav.sections.${sectionKey}`));
    else crumbs.push(t(`nav.${page}`));
  }
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex items-center gap-1 text-sm text-fg-muted">
        {crumbs.map((c, i) => (
          <li
            key={i}
            aria-current={i === crumbs.length - 1 ? 'page' : undefined}
            className={i === crumbs.length - 1 ? 'text-fg' : ''}
          >
            {i > 0 && <span aria-hidden> / </span>}
            {c}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Books: compact density, sectioned nav with keyboard hints, breadcrumb and a resizable right panel. */
export function BooksLayout() {
  const { t } = useTranslation();
  useShell('books');
  return (
    <RightPanelProvider>
      <div className="flex h-screen flex-col" data-shell="books">
        <SkipLink />
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-1.5">
          <BusinessSwitcher />
          <Breadcrumb />
          <div className="ml-auto">
            <ChromeControls shell="books" />
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label={t('nav.label')}
            className="w-56 shrink-0 overflow-auto border-r border-border p-2"
          >
            {BOOKS_NAV.map((section) => (
              <div key={section.id} className="pb-2">
                <p className="px-2 pb-0.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
                  {t(section.label)}
                </p>
                {section.items.map((item) => (
                  <NavEntry key={item.id} shell="books" item={item} />
                ))}
              </div>
            ))}
          </nav>
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-auto p-4 outline-none">
            <Outlet />
          </main>
          <RightPanel />
        </div>
      </div>
    </RightPanelProvider>
  );
}

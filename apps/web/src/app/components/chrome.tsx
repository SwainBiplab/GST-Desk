import type { Language } from '@gst/i18n';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  LanguageSwitcher,
  ThemeToggle,
  cn,
} from '@gst/ui';
import { Bell, ChevronsUpDown, CircleHelp, Monitor, Search } from '@gst/ui/icons';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { useAppDb } from '../db';
import { useAppNavigate, useCounts, useLocationInfo } from '../hooks';
import { useAppStore, type Shell } from '../store';

import { useFeatureFlags } from '@/features/business/hooks';
import { useBackupStatus } from '@/features/data/backup-service';
import { changeLanguage } from '@/lib/i18n';
import { KEYS } from '@/lib/terms';

/** Business name with a menu to switch between businesses (FR-003). */
export function BusinessSwitcher({ large = false }: { large?: boolean }) {
  const { t } = useTranslation();
  const { businesses, business } = useAppDb();
  const setBusinessId = useAppStore((s) => s.setBusinessId);
  const name = business
    ? (business['trade_name'] ?? business['legal_name'])
    : t('chrome.noBusiness');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label={t('chrome.business')}
          data-testid="business-switcher"
          className={cn('max-w-64 justify-between', large && 'min-h-11 text-base font-semibold')}
        >
          <span className="truncate">{name}</span>
          <ChevronsUpDown size={14} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {businesses.map((b) => (
          <DropdownMenuItem key={b['id']} onSelect={() => setBusinessId(b['id'])}>
            {b['trade_name'] ?? b['legal_name']}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem asChild>
          <Link to="/welcome" search={{ add: true }} data-testid="switcher-add">
            {t('chrome.addBusiness')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Placeholder until sync exists: says where the data lives. */
export function SyncPill() {
  const { t } = useTranslation();
  const { status, persistent } = useAppDb();
  const unsaved = status === 'ready' && !persistent;
  return (
    <Badge
      tone={unsaved ? 'warning' : 'neutral'}
      data-testid="sync-pill"
      data-db-status={status}
      title={unsaved ? t('chrome.notSavedTitle') : t('chrome.syncLocalTitle')}
    >
      {unsaved ? t('chrome.localNotSaved') : t('chrome.local')}
    </Badge>
  );
}

/** Bell: how many things need a look (reviews waiting, items low on stock), and a menu to each. */
export function NotificationBell({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const counts = useCounts();
  const flags = useFeatureFlags();
  const navigate = useAppNavigate();
  const backup = useBackupStatus();
  const backupFailed = !backup.ok && !!backup.error;
  const review = counts?.reviewPending ?? 0;
  const low = flags.inventory ? (counts?.lowStock ?? 0) : 0;
  const n = review + low + (backupFailed ? 1 : 0);
  const label = [
    `${t('chrome.notifications')}: ${t('chrome.notificationsCount', { count: review })}`,
    ...(flags.inventory ? [t('chrome.lowStockCount', { count: low })] : []),
    ...(backupFailed ? [t('chrome.backupFailed')] : []),
  ].join(', ');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="relative min-w-(--control-h)"
          aria-label={label}
          data-testid="bell"
        >
          <Bell size={16} aria-hidden />
          {n > 0 && (
            <span className="absolute -right-0.5 -top-0.5 rounded-full bg-danger px-1 text-xs text-danger-fg">
              {n}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem data-testid="bell-review" onSelect={() => navigate(`/${shell}/inbox`)}>
          {t('chrome.notificationsCount', { count: review })}
        </DropdownMenuItem>
        {backupFailed && (
          <DropdownMenuItem
            data-testid="bell-backup"
            onSelect={() => navigate(`/${shell}/settings`, { tab: 'backup' })}
          >
            {t('chrome.backupFailed')}
          </DropdownMenuItem>
        )}
        {flags.inventory && (
          <DropdownMenuItem
            data-testid="bell-low-stock"
            onSelect={() =>
              navigate(`/${shell}/reports`, {
                report: 'stock_summary',
                preset: 'today',
                type: 'low',
              })
            }
          >
            {t('chrome.lowStockCount', { count: low })}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function HelpMenu() {
  const { t } = useTranslation();
  const setKeymapOpen = useAppStore((s) => s.setKeymapOpen);
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label={t('chrome.help')} className="min-w-(--control-h)">
          <CircleHelp size={16} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setKeymapOpen(true)}>
          {t('chrome.keyboardMap')} (?)
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setCommandOpen(true)}>
          {t('actions.search')} ({KEYS.commandBar})
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const DENSITY_KEY = (shell: Shell) => `gst.density.${shell}`;
export const DEFAULT_DENSITY: Record<Shell, 'comfortable' | 'compact'> = {
  shop: 'comfortable',
  books: 'compact',
};

export function readDensity(shell: Shell): 'comfortable' | 'compact' {
  try {
    const v = localStorage.getItem(DENSITY_KEY(shell));
    if (v === 'compact' || v === 'comfortable') return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_DENSITY[shell];
}

export function applyDensity(shell: Shell, value = readDensity(shell)) {
  document.documentElement.setAttribute('data-density', value);
}

export function toggleDensity(shell: Shell) {
  const next = readDensity(shell) === 'compact' ? 'comfortable' : 'compact';
  try {
    localStorage.setItem(DENSITY_KEY(shell), next);
  } catch {
    /* ignore */
  }
  applyDensity(shell, next);
  useAppStore.getState().bumpDensity();
}

/** Density is remembered per shell: Shop defaults to comfortable, Books to compact. */
export function DensityButton({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  useAppStore((s) => s.densityTick);
  const density = readDensity(shell);
  return (
    <Button
      variant="ghost"
      aria-label={t('chrome.density')}
      data-testid="density-toggle"
      onClick={() => {
        toggleDensity(shell);
      }}
    >
      <Monitor size={16} aria-hidden />
      <span className="hidden lg:inline">
        {t(density === 'compact' ? 'chrome.compact' : 'chrome.comfortable')}
      </span>
    </Button>
  );
}

/** Shop | Books toggle. Switching keeps the page (Parties stays Parties) and only changes the layout. */
export function ShellSwitch({ shell }: { shell: Shell }) {
  const { t } = useTranslation();
  const { page } = useLocationInfo();
  const setShell = useAppStore((s) => s.setShell);
  return (
    <div
      role="group"
      aria-label={t('shell.switch')}
      className="inline-flex rounded-md border border-border p-0.5"
    >
      {(['shop', 'books'] as const).map((s) => (
        <Link
          key={s}
          to={`/${s}/$page` as '/shop/$page'}
          params={{ page: page ?? 'dashboard' }}
          onClick={() => setShell(s)}
          aria-current={s === shell ? 'page' : undefined}
          data-testid={`switch-${s}`}
          className={cn(
            'inline-flex h-(--control-h) items-center rounded-sm px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring',
            s === shell ? 'bg-accent text-accent-fg' : 'text-fg hover:bg-surface-2',
          )}
        >
          {t(`shell.${s}`)}
        </Link>
      ))}
    </div>
  );
}

export function SearchButton() {
  const { t } = useTranslation();
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  return (
    <Button
      variant="outline"
      onClick={() => setCommandOpen(true)}
      data-testid="open-command-bar"
      className="min-w-40 justify-start gap-2 text-fg-muted"
    >
      <Search size={14} aria-hidden />
      <span className="hidden md:inline">{t('actions.search')}</span>
      <kbd className="ml-auto hidden rounded-sm border border-border px-1 text-xs md:inline">
        {KEYS.commandBarCap}
      </kbd>
    </Button>
  );
}

/** Language of the screens: the choice applies at once, with no reload, and is kept on this device. */
function UiLanguageSwitcher() {
  const { t, i18n } = useTranslation();
  return (
    <LanguageSwitcher
      current={i18n.language}
      label={t('chrome.language')}
      onChange={(code) => void changeLanguage(code as Language)}
    />
  );
}

/** The controls both shells share, in one row. */
export function ChromeControls({ shell }: { shell: Shell }) {
  return (
    <div className="flex items-center gap-1">
      <ShellSwitch shell={shell} />
      <SearchButton />
      <DensityButton shell={shell} />
      <ThemeToggle />
      <UiLanguageSwitcher />
      <SyncPill />
      <NotificationBell shell={shell} />
      <HelpMenu />
    </div>
  );
}

import { cn } from '@gst/ui';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { useCounts, useLocationInfo } from '../hooks';
import type { NavItem } from '../nav';
import type { Shell } from '../store';

import { dyn } from '@/lib/dyn-key';

function isActive(item: NavItem, page: string | null, search: Record<string, unknown>): boolean {
  if (item.page !== page) return false;
  if (item.search) return Object.entries(item.search).every(([k, v]) => search[k] === v);
  // the plain item is not active when a sibling with extra search params is
  return (
    !(item.page === 'documents' && search['kind'] === 'purchases') &&
    !(item.page === 'reports' && search['section'] === 'gst')
  );
}

export function NavEntry({
  shell,
  item,
  compact,
}: {
  shell: Shell;
  item: NavItem;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { page, search } = useLocationInfo();
  const counts = useCounts();
  const active = isActive(item, page, search);
  const badge = item.badge && counts ? counts[item.badge] : undefined;
  const Icon = item.icon;
  const label = t(dyn(item.label));
  return (
    <Link
      to={`/${shell}/$page` as '/shop/$page'}
      params={{ page: item.page }}
      {...(item.search ? { search: item.search as never } : {})}
      aria-current={active ? 'page' : undefined}
      aria-label={compact ? `${label}${badge ? ` (${badge})` : ''}` : undefined}
      title={compact ? label : undefined}
      data-testid={`nav-${item.id}`}
      className={cn(
        'relative flex items-center gap-2 rounded-md px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring',
        compact ? 'min-h-11 min-w-11 justify-center' : 'h-(--control-h)',
        active
          ? 'bg-surface-3 font-medium text-fg'
          : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
      )}
    >
      <Icon size={18} aria-hidden />
      {!compact && (
        <>
          <span className="flex-1 truncate">{label}</span>
          {item.hint && <kbd className="hidden text-xs text-fg-muted xl:inline">{item.hint}</kbd>}
        </>
      )}
      {badge !== undefined && badge > 0 && (
        <span
          data-testid={`badge-${item.id}`}
          className={cn(
            'tabular rounded-full bg-surface-2 px-1.5 text-xs text-fg-muted',
            compact && 'absolute -right-1 -top-1 border border-border',
          )}
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

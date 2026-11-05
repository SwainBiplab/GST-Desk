import { Inbox, Languages, Monitor, Moon, Sun } from 'lucide-react';
import * as React from 'react';

import { cn } from '../lib/cn';

import { Badge } from './display';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './overlays';
import { Button } from './primitives';

/* ---------- StatusPill ---------- */
export type DocumentStatus = 'draft' | 'issued' | 'paid' | 'partial' | 'overdue' | 'cancelled';
export type SyncStatus = 'synced' | 'pending' | 'syncing' | 'conflict' | 'offline';
export type Status = DocumentStatus | SyncStatus;

const statusMap: Record<
  Status,
  { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }
> = {
  draft: { label: 'Draft', tone: 'neutral' },
  issued: { label: 'Issued', tone: 'info' },
  paid: { label: 'Paid', tone: 'success' },
  partial: { label: 'Partly paid', tone: 'warning' },
  overdue: { label: 'Overdue', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  synced: { label: 'Synced', tone: 'success' },
  pending: { label: 'Pending sync', tone: 'warning' },
  syncing: { label: 'Syncing', tone: 'info' },
  conflict: { label: 'Conflict', tone: 'danger' },
  offline: { label: 'Offline', tone: 'neutral' },
};

export function StatusPill({ status, label }: { status: Status; label?: string }) {
  const s = statusMap[status];
  return <Badge tone={s.tone}>{label ?? s.label}</Badge>;
}

/* ---------- Layout shells ---------- */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center">
      <div className="text-fg-muted">{icon ?? <Inbox size={32} aria-hidden />}</div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-fg-muted">{description}</p>}
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 pb-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <p className="text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

/** Shell only; trace content is supplied by feature prompts. */
export function TracePanel({
  title = 'Trace',
  children,
}: {
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <aside aria-label={title} className="rounded-lg border border-border bg-surface-1 p-3">
      <h2 className="pb-2 text-sm font-semibold">{title}</h2>
      {children ?? <p className="text-fg-muted">Nothing to show yet.</p>}
    </aside>
  );
}

/** Shell only; review inbox items arrive in prompt 21. */
export function InboxCard({
  title,
  children,
  actions,
  className,
}: {
  title: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface-1 p-3', className)}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="py-2">{children}</div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </section>
  );
}

/* ---------- Toggles (write data-* on <html>) ---------- */
function setRootAttr(name: string, value: string) {
  document.documentElement.setAttribute(name, value);
  try {
    localStorage.setItem(name, value);
  } catch {
    /* storage unavailable */
  }
}

function useRootAttr(name: string, fallback: string) {
  const [value, setValue] = React.useState(
    () => document.documentElement.getAttribute(name) ?? fallback,
  );
  const update = React.useCallback(
    (next: string) => {
      setRootAttr(name, next);
      setValue(next);
    },
    [name],
  );
  return [value, update] as const;
}

export function ThemeToggle() {
  const [theme, setTheme] = useRootAttr('data-theme', 'light');
  const dark = theme === 'dark';
  return (
    <Button
      variant="ghost"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
    </Button>
  );
}

export function DensityToggle() {
  const [density, setDensity] = useRootAttr('data-density', 'comfortable');
  const compact = density === 'compact';
  return (
    <Button
      variant="ghost"
      aria-pressed={compact}
      onClick={() => setDensity(compact ? 'comfortable' : 'compact')}
    >
      <Monitor size={16} aria-hidden />
      {compact ? 'Compact' : 'Comfortable'}
    </Button>
  );
}

export interface LanguageOption {
  code: string;
  label: string;
}

export const defaultLanguages: LanguageOption[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ta', label: 'தமிழ்' },
  { code: 'bn', label: 'বাংলা' },
  { code: 'gu', label: 'ગુજરાતી' },
  { code: 'mr', label: 'मराठी' },
];

/** Switches the document `lang`, which drives the font fallback stack and line-height tokens. */
export function LanguageSwitcher({
  languages = defaultLanguages,
  current,
  label = 'Language',
  onChange,
}: {
  languages?: LanguageOption[];
  /** The language in use, marked in the list. */
  current?: string;
  /** The accessible name of the button, in the language of the screen. */
  label?: string;
  onChange?: (code: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label={label} data-testid="language-switcher">
          <Languages size={16} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {languages.map((l) => (
          <DropdownMenuItem
            key={l.code}
            data-testid={`lang-${l.code}`}
            lang={l.code}
            aria-current={l.code === current ? 'true' : undefined}
            onSelect={() => {
              document.documentElement.lang = l.code;
              onChange?.(l.code);
            }}
          >
            {l.label}
            {l.code === current ? ' ✓' : ''}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import type { Counts } from '@gst/db';
import type { FlagKey } from '@gst/domain';
import {
  BookOpen,
  Boxes,
  FileText,
  Inbox,
  LayoutDashboard,
  Percent,
  Receipt,
  Settings,
  ShoppingCart,
  Users,
  Wallet,
  type LucideProps,
} from '@gst/ui/icons';
import type { ComponentType } from 'react';

export type PageId =
  | 'dashboard'
  | 'sell'
  | 'parties'
  | 'items'
  | 'documents'
  | 'payments'
  | 'reports'
  | 'gst'
  | 'inbox'
  | 'settings';

export const PAGE_IDS: PageId[] = [
  'dashboard',
  'sell',
  'parties',
  'items',
  'documents',
  'payments',
  'reports',
  'gst',
  'inbox',
  'settings',
];

export const isPageId = (v: string): v is PageId => (PAGE_IDS as string[]).includes(v);

export interface NavItem {
  id: string;
  page: PageId;
  /** i18n key for the label. */
  label: string;
  icon: ComponentType<LucideProps>;
  badge?: keyof Counts;
  /** Extra search params that distinguish items sharing a page (Purchases, GST). */
  search?: Record<string, string>;
  /** Books go-to hint shown beside the label, e.g. `G P`. */
  hint?: string;
  /** Hidden when this feature flag is off for the business. */
  flag?: FlagKey;
}

const item = (page: PageId, icon: NavItem['icon'], extra: Partial<NavItem> = {}): NavItem => ({
  id: extra.id ?? page,
  page,
  label: `nav.${page}`,
  icon,
  ...extra,
});

export const SHOP_NAV: NavItem[] = [
  item('dashboard', LayoutDashboard),
  item('sell', ShoppingCart),
  item('parties', Users, { badge: 'parties' }),
  item('items', Boxes, { badge: 'items' }),
  item('documents', FileText, { badge: 'documents' }),
  item('payments', Wallet, { badge: 'payments' }),
  item('reports', BookOpen),
  item('inbox', Inbox, { badge: 'reviewPending' }),
  item('settings', Settings),
];

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

export const BOOKS_NAV: NavSection[] = [
  {
    id: 'overview',
    label: 'nav.sections.overview',
    items: [item('dashboard', LayoutDashboard, { hint: 'G H' })],
  },
  {
    id: 'sales',
    label: 'nav.sections.sales',
    items: [
      item('sell', ShoppingCart),
      item('documents', FileText, { badge: 'documents', hint: 'G D' }),
    ],
  },
  {
    id: 'purchases',
    label: 'nav.sections.purchases',
    items: [
      item('documents', Receipt, {
        id: 'purchases',
        label: 'nav.purchases',
        search: { kind: 'purchases' },
        flag: 'purchases',
      }),
    ],
  },
  {
    id: 'parties',
    label: 'nav.sections.parties',
    items: [item('parties', Users, { badge: 'parties', hint: 'G P' })],
  },
  {
    id: 'items',
    label: 'nav.sections.items',
    items: [item('items', Boxes, { badge: 'items', hint: 'G I' })],
  },
  {
    id: 'money',
    label: 'nav.sections.money',
    items: [item('payments', Wallet, { badge: 'payments', hint: 'G M' })],
  },
  {
    id: 'reports',
    label: 'nav.sections.reports',
    items: [item('reports', BookOpen, { hint: 'G R' })],
  },
  {
    id: 'gst',
    label: 'nav.sections.gst',
    items: [item('gst', Percent, { id: 'gst', label: 'nav.gst' })],
  },
  {
    id: 'inbox',
    label: 'nav.sections.inbox',
    items: [item('inbox', Inbox, { badge: 'reviewPending', hint: 'G B' })],
  },
  {
    id: 'settings',
    label: 'nav.sections.settings',
    items: [item('settings', Settings, { hint: 'G S' })],
  },
];

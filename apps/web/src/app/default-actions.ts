import { REPORTS, REPORT_IDS } from '@gst/db';

import i18n from '../lib/i18n';

import { registerAction, type ActionContext } from './actions';
import { PAGE_IDS, type PageId } from './nav';
import { GO_TO } from './shortcuts';

import { dyn } from '@/lib/dyn-key';

const t = (key: string, opts?: Record<string, unknown>): string =>
  opts ? (i18n.t(dyn(key), opts) as string) : (i18n.t(dyn(key)) as string);
const shellOf = (c: ActionContext) => c.shell ?? 'shop';
const go = (page: PageId, search?: Record<string, unknown>) => (c: ActionContext) =>
  c.navigate(`/${shellOf(c)}/${page}`, search);

/** Open the editor on a new document. Books has its own route; Shop's editor is the Sell page. */
const newDoc = (type: string) => (c: ActionContext) =>
  c.navigate(shellOf(c) === 'shop' ? '/shop/sell' : '/books/documents/new', { type });

const KEYWORDS: Record<PageId, string[]> = {
  dashboard: ['home', 'overview'],
  sell: ['bill', 'invoice', 'checkout', 'pos'],
  parties: ['customers', 'suppliers', 'contacts'],
  items: ['products', 'stock', 'inventory', 'hsn'],
  documents: ['invoices', 'bills', 'quotations', 'credit notes'],
  payments: ['money', 'receipts', 'cash', 'bank'],
  reports: ['gst', 'gstr', 'ledger', 'summary'],
  inbox: ['review', 'scan', 'notifications'],
  settings: ['preferences', 'business', 'setup'],
};

const HINT: Partial<Record<PageId, string>> = Object.fromEntries(
  Object.entries(GO_TO).map(([k, v]) => [v.page, `G then ${k.toUpperCase()}`]),
);

/**
 * Register the built-in actions. Their titles are words, so this runs again when the language is ready
 * and whenever it changes (registering an id again replaces it). Features add theirs with `registerAction`.
 */
export function registerDefaultActions(): void {
  for (const page of PAGE_IDS) {
    registerAction({
      id: `nav.${page}`,
      title: t('act.goTo', { page: t(`nav.${page}`) }),
      section: t('act.section.goTo'),
      keywords: KEYWORDS[page],
      ...(HINT[page] ? { shortcut: HINT[page] } : {}),
      run: go(page),
    });
  }

  const section = (k: string) => t(`act.section.${k}`);
  registerAction({
    id: 'new.invoice',
    title: t('act.newInvoice'),
    section: section('new'),
    keywords: ['sale', 'bill', 'sell'],
    shortcut: 'N',
    run: newDoc('tax_invoice'),
  });
  registerAction({
    id: 'new.quotation',
    title: t('act.newQuotation'),
    section: section('new'),
    keywords: ['quote', 'estimate'],
    when: (c) => c.flags.quotations,
    run: newDoc('quotation'),
  });
  registerAction({
    id: 'new.purchase',
    title: t('act.newPurchase'),
    section: section('new'),
    keywords: ['buy', 'supplier bill'],
    when: (c) => c.flags.purchases,
    run: newDoc('purchase_bill'),
  });
  registerAction({
    id: 'new.party',
    title: t('act.newParty'),
    section: section('new'),
    keywords: ['customer', 'supplier'],
    run: go('parties', { new: '1' }),
  });
  registerAction({
    id: 'new.item',
    title: t('act.newItem'),
    section: section('new'),
    keywords: ['product', 'service'],
    run: go('items', { new: '1' }),
  });

  registerAction({
    id: 'import.items',
    title: t('act.importItems'),
    section: section('data'),
    keywords: ['csv', 'upload', 'products', 'bulk'],
    run: go('items', { import: '1' }),
  });
  registerAction({
    id: 'import.parties',
    title: t('act.importParties'),
    section: section('data'),
    keywords: ['csv', 'upload', 'customers', 'suppliers', 'bulk'],
    run: go('parties', { import: '1' }),
  });

  registerAction({
    id: 'money.receive',
    title: t('act.receive'),
    section: section('money'),
    keywords: ['collect', 'customer paid'],
    run: go('payments', { intent: 'receive' }),
  });
  registerAction({
    id: 'money.pay',
    title: t('act.pay'),
    section: section('money'),
    keywords: ['supplier', 'paid'],
    run: go('payments', { intent: 'pay' }),
  });
  registerAction({
    id: 'stock.adjust',
    title: t('act.adjustStock'),
    section: section('data'),
    keywords: ['inventory', 'count', 'stocktake', 'quantity'],
    when: (c) => c.flags.inventory,
    run: go('items', { adjust: '1' }),
  });
  // every report is one keystroke away: "Open report: Sales register"
  for (const id of REPORT_IDS) {
    const def = REPORTS[id];
    registerAction({
      id: `report.${id}`,
      title: t('act.openReport', { name: t(`reports.r.${id}.title`) }),
      section: section('reports'),
      keywords: ['report', def.section, id.replace(/_/g, ' ')],
      ...(def.flag ? { when: (c: ActionContext) => c.flags[def.flag!] } : {}),
      run: go('reports', { report: id }),
    });
  }
  registerAction({
    id: 'inbox.scan',
    title: t('act.scan'),
    section: section('new'),
    keywords: ['purchase bill', 'ocr', 'upload'],
    run: go('inbox', { intent: 'scan' }),
  });

  for (const s of ['shop', 'books'] as const) {
    registerAction({
      id: `mode.${s}`,
      title: t('act.switchTo', { shell: t(`shell.${s}`) }),
      section: section('mode'),
      keywords: ['mode', 'layout'],
      when: (c) => c.shell !== s,
      run: (c) => c.ui.switchShell(s),
    });
  }

  registerAction({
    id: 'ui.theme',
    title: t('act.theme'),
    section: section('settings'),
    keywords: ['dark', 'light', 'theme'],
    run: (c) => c.ui.toggleTheme(),
  });
  registerAction({
    id: 'ui.density',
    title: t('act.density'),
    section: section('settings'),
    keywords: ['compact', 'comfortable', 'dense'],
    run: (c) => c.ui.toggleDensity(),
  });
  registerAction({
    id: 'help.keymap',
    title: t('act.keymap'),
    section: section('help'),
    keywords: ['shortcuts', 'keys', 'help'],
    shortcut: '?',
    run: (c) => c.ui.openKeymap(),
  });
  registerAction({
    id: 'data.demo',
    title: t('act.demo'),
    section: section('data'),
    keywords: ['sample', 'seed', 'example'],
    when: (c) => !c.businessId,
    run: (c) => c.ui.loadDemoData(),
  });
}

/**
 * Who may do what (prompt 42, FR-131). One matrix of modules and actions, read by the app (to hide or
 * disable what a person cannot do) and by the cloud API and its sync write path (to refuse it). A role is
 * a set of grants; the built-in roles are below and an organisation can make its own.
 *
 * Documents are split by kind, so a counter can raise invoices without touching purchases. Tables that
 * only follow from another change (ledger postings, stock movements of an invoice, audit rows) are
 * allowed when the change they follow is: see `tableAccess`.
 */
import type { DocumentType } from './turnover';

export const MODULES = [
  'parties',
  'items',
  'inventory',
  'sales',
  'notes',
  'quotes',
  'purchases',
  'payments',
  'reports',
  'gst',
  'settings',
  'team',
  'audit',
] as const;
export type Module = (typeof MODULES)[number];

export const ACTIONS = ['view', 'create', 'edit', 'issue', 'cancel', 'export', 'approve'] as const;
export type Action = (typeof ACTIONS)[number];

/** The actions that mean something for each module (the grid of the role editor). */
export const MODULE_ACTIONS: Record<Module, readonly Action[]> = {
  parties: ['view', 'create', 'edit', 'export'],
  items: ['view', 'create', 'edit', 'export'],
  inventory: ['view', 'create', 'edit', 'export'],
  sales: ['view', 'create', 'edit', 'issue', 'cancel', 'export', 'approve'],
  notes: ['view', 'create', 'edit', 'issue', 'cancel', 'export', 'approve'],
  quotes: ['view', 'create', 'edit', 'issue', 'cancel', 'export'],
  purchases: ['view', 'create', 'edit', 'issue', 'cancel', 'export', 'approve'],
  payments: ['view', 'create', 'edit', 'cancel', 'export', 'approve'],
  reports: ['view', 'export'],
  gst: ['view', 'create', 'edit', 'export'],
  settings: ['view', 'edit'],
  team: ['view', 'create', 'edit'],
  audit: ['view', 'export'],
};

/** Which module a document kind belongs to. */
export const DOCUMENT_MODULE: Record<DocumentType, Module> = {
  tax_invoice: 'sales',
  bill_of_supply: 'sales',
  receipt_voucher: 'sales',
  credit_note: 'notes',
  debit_note: 'notes',
  quotation: 'quotes',
  proforma: 'quotes',
  delivery_challan: 'quotes',
  purchase_bill: 'purchases',
  purchase_return: 'purchases',
  expense: 'purchases',
  rcm_self_invoice: 'purchases',
};

export const documentModule = (type: string): Module =>
  DOCUMENT_MODULE[type as DocumentType] ?? 'sales';

export type Grants = Partial<Record<Module, readonly Action[]>>;

const all = (m: Module): readonly Action[] => MODULE_ACTIONS[m];
const only = (m: Module, ...a: Action[]): readonly Action[] =>
  MODULE_ACTIONS[m].filter((x) => a.includes(x));
const every = (pick: (m: Module) => readonly Action[]): Grants =>
  Object.fromEntries(MODULES.map((m) => [m, pick(m)])) as Grants;
const READ: Action[] = ['view', 'export'];

export const BUILTIN_ROLES = [
  'owner',
  'admin',
  'accountant',
  'sales',
  'inventory',
  'viewer',
] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];
export const isBuiltinRole = (r: unknown): r is BuiltinRole =>
  BUILTIN_ROLES.includes(r as BuiltinRole);

export const ROLE_GRANTS: Record<BuiltinRole, Grants> = {
  owner: every(all),
  /** Everything but the owners: see `canManage`. */
  admin: every(all),
  /** The "accountant" invite preset: reads and exports everything, and runs GST work. */
  accountant: {
    ...every((m) => only(m, ...READ)),
    gst: all('gst'),
    team: only('team', 'view'),
    settings: only('settings', 'view'),
  },
  /** A counter: customers, sales and receipts. */
  sales: {
    parties: only('parties', 'view', 'create', 'edit'),
    items: only('items', 'view'),
    inventory: only('inventory', 'view'),
    sales: only('sales', 'view', 'create', 'edit', 'issue'),
    notes: only('notes', 'view'),
    quotes: only('quotes', 'view', 'create', 'edit', 'issue'),
    payments: only('payments', 'view', 'create'),
    settings: only('settings', 'view'),
    team: only('team', 'view'),
  },
  /** The store: items, stock and the purchases that bring it in. */
  inventory: {
    parties: only('parties', 'view'),
    items: only('items', 'view', 'create', 'edit', 'export'),
    inventory: all('inventory'),
    quotes: only('quotes', 'view', 'create', 'edit', 'issue'),
    purchases: only('purchases', 'view', 'create', 'edit'),
    settings: only('settings', 'view'),
    team: only('team', 'view'),
  },
  viewer: {
    ...every((m) => only(m, 'view')),
    audit: [],
  },
};

/** The roles shown when inviting, in order; the accountant preset is its own button. */
export const INVITE_ROLES: readonly BuiltinRole[] = [
  'admin',
  'accountant',
  'sales',
  'inventory',
  'viewer',
];

/** Keep only real module/action pairs (a custom role arriving from a device or an old version). */
export function cleanGrants(g: unknown): Grants {
  const out: Grants = {};
  if (!g || typeof g !== 'object') return out;
  for (const m of MODULES) {
    const v = (g as Record<string, unknown>)[m];
    if (!Array.isArray(v)) continue;
    const allowed = MODULE_ACTIONS[m];
    const acts = allowed.filter((a) => v.includes(a));
    // anything granted on a module implies seeing it
    if (acts.length && !acts.includes('view')) acts.unshift('view');
    if (acts.length) out[m] = acts;
  }
  return out;
}

export interface Permissions {
  /** `owner`, `admin`, ... or `custom`. */
  role: BuiltinRole | 'custom';
  /** The custom role's name, when there is one. */
  roleName?: string;
  grants: Grants;
}

export const permissionsOf = (role: BuiltinRole): Permissions => ({
  role,
  grants: ROLE_GRANTS[role],
});

export function can(p: Permissions | Grants | null | undefined, m: Module, a: Action): boolean {
  if (!p) return false;
  const g: Grants = 'grants' in p ? (p as Permissions).grants : (p as Grants);
  return !!g[m]?.includes(a);
}

/** Can this person write anything at all (so audit rows and inbox decisions from them are expected)? */
export const canWriteAnything = (p: Permissions): boolean =>
  MODULES.some((m) => (p.grants[m] ?? []).some((a) => a !== 'view' && a !== 'export'));

/** Is `inner` no wider than `outer`: nobody can hand out more than they hold. */
export function grantsWithin(inner: Grants, outer: Grants): boolean {
  return MODULES.every((m) => (inner[m] ?? []).every((a) => (outer[m] ?? []).includes(a)));
}

/**
 * May `actor` change `target`'s role to `next` (or remove them, `next` null)? Owners can do anything but
 * leave the organisation without an owner (the caller checks the count); others need `team.edit`, cannot
 * touch an owner or make one, and cannot give more than they hold.
 */
export function canManage(
  actor: Permissions,
  target: { role: BuiltinRole | 'custom' } | null,
  next: Permissions | null,
): boolean {
  if (!can(actor, 'team', 'edit')) return false;
  if (actor.role === 'owner') return true;
  if (target?.role === 'owner' || next?.role === 'owner') return false;
  if (next && !grantsWithin(next.grants, actor.grants)) return false;
  return true;
}

/** An organisation's rules for what needs an owner's approval (FR-131). Off unless turned on. */
export interface ApprovalPolicy {
  /** Cancellations and money changes to issued documents by people without `approve` wait for one. */
  approvals: boolean;
}

export const DEFAULT_POLICY: ApprovalPolicy = { approvals: false };

export type ChangeKind = 'cancel' | 'revise';

/** Does this change wait for approval under the policy? */
export function needsApproval(
  p: Permissions,
  policy: ApprovalPolicy,
  m: Module,
  change: ChangeKind,
): boolean {
  if (!policy.approvals) return false;
  if (!(MODULE_ACTIONS[m] as readonly string[]).includes('approve')) return false;
  if (can(p, m, 'approve')) return false;
  return change === 'cancel' || change === 'revise';
}

/**
 * What a row change needs, by table. `follows` tables are written as a consequence of another change
 * (ledger postings, an invoice's stock movement, its lines): they are allowed when the transaction also
 * changes something the person may change in `module`, or when they have the module themselves.
 */
export interface TableAccess {
  module: Module | 'document';
  /** Allowed alongside a permitted change to a document or payment in the same transaction. */
  follows?: boolean;
  /** Anyone who can write anything (audit rows, inbox decisions, numbering). */
  anyWriter?: boolean;
  /** Never from a device: the server owns these. */
  serverOnly?: boolean;
}

const TABLES: Record<string, TableAccess> = {
  businesses: { module: 'settings' },
  memberships: { module: 'team', serverOnly: true },
  devices: { module: 'team', serverOnly: true },
  business_accounts: { module: 'settings' },
  templates: { module: 'settings' },
  settings: { module: 'settings' },
  import_mappings: { module: 'settings' },
  units: { module: 'items' },
  parties: { module: 'parties', follows: true },
  items: { module: 'items', follows: true },
  item_variants: { module: 'items' },
  hsn_master: { module: 'items', serverOnly: true },
  number_series: { module: 'settings', follows: true },
  number_reservations: { module: 'settings', anyWriter: true },
  documents: { module: 'document' },
  document_lines: { module: 'document' },
  payments: { module: 'payments' },
  payment_allocations: { module: 'payments', follows: true },
  gst_filings: { module: 'gst' },
  tax_challans: { module: 'gst' },
  tax_deductions: { module: 'gst', follows: true },
  tds_receivable: { module: 'gst', follows: true },
  gst_adjustments: { module: 'gst' },
  gstr2b_imports: { module: 'gst' },
  gstr2b_entries: { module: 'gst' },
  gstr2b_decisions: { module: 'gst' },
  gst_issue_acks: { module: 'gst' },
  einvoices: { module: 'gst', follows: true },
  ewaybills: { module: 'gst', follows: true },
  gsp_jobs: { module: 'gst', follows: true },
  gsp_log: { module: 'gst', follows: true },
  ledger_accounts: { module: 'settings', follows: true },
  recurring_journals: { module: 'payments' },
  journal_vouchers: { module: 'payments' },
  ledger_entries: { module: 'payments', follows: true },
  fiscal_years: { module: 'settings' },
  reminders: { module: 'parties', follows: true },
  godowns: { module: 'inventory' },
  batches: { module: 'inventory', follows: true },
  stock_movements: { module: 'inventory', follows: true },
  serials: { module: 'inventory', follows: true },
  stock_transfers: { module: 'inventory' },
  stock_transfer_lines: { module: 'inventory', follows: true },
  godown_levels: { module: 'inventory' },
  pos_counters: { module: 'settings' },
  pos_shifts: { module: 'payments' },
  pos_cash_movements: { module: 'payments', follows: true },
  pos_bills: { module: 'sales', follows: true },
  pos_held_bills: { module: 'sales' },
  attachments: { module: 'document', anyWriter: true },
  review_items: { module: 'audit', anyWriter: true },
  audit_log: { module: 'audit', anyWriter: true },
};

export const tableAccess = (table: string): TableAccess => TABLES[table] ?? { module: 'settings' };

/** The action a row change is, for documents by what happens to its status. */
export function changeAction(
  op: 'PUT' | 'PATCH' | 'DELETE',
  before: { status?: unknown; revision?: unknown } | null,
  after: { status?: unknown; revision?: unknown; deleted_at?: unknown },
): Action {
  if (op === 'PUT' && !before) return after.status === 'issued' ? 'issue' : 'create';
  if (after.status === 'cancelled' && before?.status !== 'cancelled') return 'cancel';
  if (after.status === 'issued' && before?.status === 'draft') return 'issue';
  return 'edit';
}

/** LAN tablet roles (prompt 35) in the same terms, so the app enforces one model everywhere. */
export const LAN_ROLE_PERMISSIONS: Record<'full' | 'counter' | 'view', Permissions> = {
  full: { role: 'admin', grants: ROLE_GRANTS.admin },
  counter: { role: 'sales', grants: ROLE_GRANTS.sales },
  view: { role: 'viewer', grants: ROLE_GRANTS.viewer },
};

/** A book on this computer, not shared: its one user owns it. */
export const LOCAL_OWNER: Permissions = permissionsOf('owner');

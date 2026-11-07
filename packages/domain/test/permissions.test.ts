import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  BUILTIN_ROLES,
  MODULES,
  MODULE_ACTIONS,
  ROLE_GRANTS,
  can,
  canManage,
  changeAction,
  cleanGrants,
  documentModule,
  grantsWithin,
  needsApproval,
  permissionsOf,
  tableAccess,
  type Permissions,
} from '../src/permissions';

const custom = (grants: Permissions['grants']): Permissions => ({ role: 'custom', grants });

describe('the permission matrix', () => {
  it('grants only actions that exist for each module', () => {
    for (const r of BUILTIN_ROLES)
      for (const m of MODULES)
        for (const a of ROLE_GRANTS[r][m] ?? [])
          expect(MODULE_ACTIONS[m], `${r} ${m}`).toContain(a);
  });

  it('matches the expected grid for every built-in role', () => {
    const grid = Object.fromEntries(
      BUILTIN_ROLES.map((r) => [
        r,
        MODULES.map((m) => `${m}:${ACTIONS.filter((a) => can(permissionsOf(r), m, a)).join(',')}`),
      ]),
    );
    expect(grid).toMatchSnapshot();
  });

  it('lets a viewer change nothing and an owner everything', () => {
    for (const m of MODULES) {
      for (const a of MODULE_ACTIONS[m]) {
        expect(can(permissionsOf('owner'), m, a)).toBe(true);
        if (a !== 'view') expect(can(permissionsOf('viewer'), m, a), `${m}.${a}`).toBe(false);
      }
    }
  });

  it('gives the accountant read and GST, and no sales or team changes', () => {
    const p = permissionsOf('accountant');
    expect(can(p, 'gst', 'edit')).toBe(true);
    expect(can(p, 'reports', 'export')).toBe(true);
    expect(can(p, 'sales', 'view')).toBe(true);
    expect(can(p, 'sales', 'issue')).toBe(false);
    expect(can(p, 'team', 'edit')).toBe(false);
  });

  it('keeps a counter to sales and receipts', () => {
    const p = permissionsOf('sales');
    expect(can(p, 'sales', 'issue')).toBe(true);
    expect(can(p, 'sales', 'cancel')).toBe(false);
    expect(can(p, 'purchases', 'view')).toBe(false);
    expect(can(p, 'payments', 'create')).toBe(true);
  });

  it('cleans a custom role: unknown pairs dropped, any grant implies view', () => {
    expect(
      cleanGrants({ sales: ['issue', 'fly'], team: ['approve'], bogus: ['view'], reports: 'x' }),
    ).toEqual({ sales: ['view', 'issue'] });
  });

  it('maps every document kind to a module that has documents', () => {
    expect(documentModule('tax_invoice')).toBe('sales');
    expect(documentModule('credit_note')).toBe('notes');
    expect(documentModule('purchase_bill')).toBe('purchases');
    expect(documentModule('delivery_challan')).toBe('quotes');
  });
});

describe('managing the team', () => {
  const owner = permissionsOf('owner');
  const admin = permissionsOf('admin');
  const sales = permissionsOf('sales');

  it('lets only people with team.edit change roles', () => {
    expect(canManage(sales, { role: 'viewer' }, permissionsOf('viewer'))).toBe(false);
    expect(canManage(permissionsOf('accountant'), { role: 'viewer' }, null)).toBe(false);
  });

  it('never lets an admin touch or make an owner', () => {
    expect(canManage(admin, { role: 'owner' }, permissionsOf('viewer'))).toBe(false);
    expect(canManage(admin, { role: 'viewer' }, permissionsOf('owner'))).toBe(false);
    expect(canManage(admin, { role: 'owner' }, null)).toBe(false);
    expect(canManage(owner, { role: 'owner' }, permissionsOf('admin'))).toBe(true);
  });

  it('never lets someone hand out more than they hold', () => {
    const teamLead = custom({ team: ['view', 'create', 'edit'], sales: ['view', 'create'] });
    expect(canManage(teamLead, { role: 'viewer' }, custom({ sales: ['view'] }))).toBe(true);
    expect(canManage(teamLead, { role: 'viewer' }, permissionsOf('sales'))).toBe(false);
    expect(grantsWithin(ROLE_GRANTS.viewer, ROLE_GRANTS.admin)).toBe(true);
    expect(grantsWithin(ROLE_GRANTS.admin, ROLE_GRANTS.accountant)).toBe(false);
  });
});

describe('approvals', () => {
  it('are off unless the organisation turns them on', () => {
    expect(needsApproval(permissionsOf('sales'), { approvals: false }, 'sales', 'cancel')).toBe(
      false,
    );
  });

  it('hold cancellations and revisions by people who cannot approve', () => {
    const on = { approvals: true };
    expect(needsApproval(permissionsOf('sales'), on, 'sales', 'cancel')).toBe(true);
    expect(needsApproval(permissionsOf('sales'), on, 'sales', 'revise')).toBe(true);
    expect(needsApproval(permissionsOf('owner'), on, 'sales', 'cancel')).toBe(false);
    expect(needsApproval(permissionsOf('admin'), on, 'purchases', 'revise')).toBe(false);
    // quotes are not tax documents: nothing to approve
    expect(needsApproval(permissionsOf('sales'), on, 'quotes', 'cancel')).toBe(false);
  });
});

describe('row changes', () => {
  it('reads the action from what happens to a document', () => {
    expect(changeAction('PUT', null, { status: 'draft' })).toBe('create');
    expect(changeAction('PUT', null, { status: 'issued' })).toBe('issue');
    expect(changeAction('PATCH', { status: 'draft' }, { status: 'issued' })).toBe('issue');
    expect(changeAction('PATCH', { status: 'issued' }, { status: 'cancelled' })).toBe('cancel');
    expect(changeAction('PATCH', { status: 'draft' }, { status: 'draft' })).toBe('edit');
  });

  it('knows which tables only follow from another change', () => {
    expect(tableAccess('ledger_entries').follows).toBe(true);
    expect(tableAccess('memberships').serverOnly).toBe(true);
    expect(tableAccess('audit_log').anyWriter).toBe(true);
    expect(tableAccess('parties').module).toBe('parties');
  });
});

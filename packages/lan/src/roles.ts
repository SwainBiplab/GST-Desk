/**
 * What a paired device may do. Every bridge method declares what it needs; a role grants a set of those.
 * `counter` is the Shop shell on a tablet: look things up, bill, take payment. It cannot change settings,
 * numbering, taxes, templates, users or devices, and it cannot cancel or edit an issued document.
 */
export type Role = 'full' | 'counter' | 'view';
export const ROLES: Role[] = ['full', 'counter', 'view'];

export type Access = 'read' | 'sell' | 'admin';

const GRANTS: Record<Role, ReadonlySet<Access>> = {
  full: new Set<Access>(['read', 'sell', 'admin']),
  counter: new Set<Access>(['read', 'sell']),
  view: new Set<Access>(['read']),
};

export const allows = (role: Role, access: Access): boolean => GRANTS[role].has(access);
export const isRole = (v: unknown): v is Role => v === 'full' || v === 'counter' || v === 'view';

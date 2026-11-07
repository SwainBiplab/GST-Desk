/**
 * The better-auth access control shared by the server and by the CLI that generates the auth schema.
 * Identity is password-less: email OTP and phone OTP. Organisations come from better-auth's plugin and
 * are mirrored into `organisations` and `memberships` (ours) by hooks in `auth.ts`.
 */
import { createAccessControl } from 'better-auth/plugins/access';

/** What a member may touch. Prompt 42 refines this into per-feature permissions. */
export const statements = {
  business: ['create', 'read', 'update', 'delete'],
  member: ['read', 'invite', 'remove', 'update'],
  billing: ['read', 'update'],
  documents: ['read', 'write', 'issue', 'cancel'],
  inventory: ['read', 'write'],
} as const;

export const ac = createAccessControl(statements);

export const roles = {
  owner: ac.newRole({
    business: ['create', 'read', 'update', 'delete'],
    member: ['read', 'invite', 'remove', 'update'],
    billing: ['read', 'update'],
    documents: ['read', 'write', 'issue', 'cancel'],
    inventory: ['read', 'write'],
  }),
  admin: ac.newRole({
    business: ['create', 'read', 'update'],
    member: ['read', 'invite', 'remove', 'update'],
    billing: ['read'],
    documents: ['read', 'write', 'issue', 'cancel'],
    inventory: ['read', 'write'],
  }),
  accountant: ac.newRole({
    business: ['read', 'update'],
    member: ['read'],
    billing: ['read'],
    documents: ['read', 'write', 'issue', 'cancel'],
    inventory: ['read'],
  }),
  sales: ac.newRole({
    business: ['read'],
    member: ['read'],
    billing: [],
    documents: ['read', 'write', 'issue'],
    inventory: ['read'],
  }),
  inventory: ac.newRole({
    business: ['read'],
    member: ['read'],
    billing: [],
    documents: ['read'],
    inventory: ['read', 'write'],
  }),
  viewer: ac.newRole({
    business: ['read'],
    member: ['read'],
    billing: [],
    documents: ['read'],
    inventory: ['read'],
  }),
};

export type OrgRole = keyof typeof roles;
export const ORG_ROLES = Object.keys(roles) as OrgRole[];

/** better-auth roles to the `memberships.role` the shared schema knows (prompt 42 widens the enum). */
export const MEMBERSHIP_ROLE: Record<
  OrgRole,
  'owner' | 'admin' | 'accountant' | 'staff' | 'viewer'
> = {
  owner: 'owner',
  admin: 'admin',
  accountant: 'accountant',
  sales: 'staff',
  inventory: 'staff',
  viewer: 'viewer',
};

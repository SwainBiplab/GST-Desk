/**
 * Identity, sessions and organisations with better-auth. Password-less: a one-time code by email or
 * SMS; cookie sessions for the browser (with better-auth's origin check as CSRF protection) and bearer
 * tokens for the desktop and mobile apps; optional TOTP for owners. Users, organisations and members
 * are mirrored into the shared tables so every repository and RLS policy sees them.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, emailOTP, organization, phoneNumber, twoFactor } from 'better-auth/plugins';

import { ac, roles, type OrgRole } from './options';
import * as schema from './schema';

export interface OtpSender {
  /** Deliver a code. The dev sender records it; MSG91 and email adapters send it. */
  send(target: {
    kind: 'email' | 'phone';
    to: string;
    code: string;
    purpose: string;
  }): Promise<void>;
}

/** What the app keeps in step with better-auth's own tables. */
export interface Mirror {
  user(u: { id: string; email: string | null; phone: string | null; name: string }): Promise<void>;
  organisation(o: { id: string; name: string }): Promise<void>;
  member(m: { id: string; organizationId: string; userId: string; role: string }): Promise<void>;
  memberRemoved(m: { id: string; organizationId: string }): Promise<void>;
}

export interface AuthOptions {
  db: any;
  secret: string;
  baseUrl: string;
  otp: OtpSender;
  trustedOrigins: string[];
  mirror: Mirror | null;
  /** better-auth's own per-address limiter; off in tests, where every call comes from one address. */
  rateLimit?: boolean;
}

export const OTP_LENGTH = 6;
export const OTP_EXPIRES_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;

export function makeAuth(o: AuthOptions) {
  const phone = (u: unknown) => (u as { phoneNumber?: string | null }).phoneNumber ?? null;
  return betterAuth({
    appName: 'GST Desk',
    baseURL: o.baseUrl,
    basePath: '/v1/auth',
    secret: o.secret,
    trustedOrigins: o.trustedOrigins,
    database: drizzleAdapter(o.db, { provider: 'pg', schema }),
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      useSecureCookies: o.baseUrl.startsWith('https://'),
      cookiePrefix: 'gstdesk',
    },
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    rateLimit: { enabled: o.rateLimit ?? true, window: 60, max: 60 },
    user: {
      additionalFields: {
        locale: { type: 'string', required: false, defaultValue: 'en', input: true },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await o.mirror?.user({
              id: user.id,
              email: user.email ?? null,
              phone: phone(user),
              name: user.name ?? '',
            });
          },
        },
        update: {
          after: async (user) => {
            await o.mirror?.user({
              id: user.id,
              email: user.email ?? null,
              phone: phone(user),
              name: user.name ?? '',
            });
          },
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: OTP_LENGTH,
        expiresIn: OTP_EXPIRES_SECONDS,
        allowedAttempts: OTP_MAX_ATTEMPTS,
        sendVerificationOTP: async ({ email, otp, type }) => {
          await o.otp.send({ kind: 'email', to: email, code: otp, purpose: type });
        },
      }),
      phoneNumber({
        otpLength: OTP_LENGTH,
        expiresIn: OTP_EXPIRES_SECONDS,
        allowedAttempts: OTP_MAX_ATTEMPTS,
        sendOTP: async ({ phoneNumber: to, code }) => {
          await o.otp.send({ kind: 'phone', to, code, purpose: 'sign-in' });
        },
        signUpOnVerification: {
          getTempEmail: (p) => `${p.replace(/\D/g, '')}@phone.gstdesk.invalid`,
          getTempName: (p) => p,
        },
      }),
      twoFactor({ issuer: 'GST Desk' }),
      bearer(),
      organization({
        ac,
        roles,
        creatorRole: 'owner' satisfies OrgRole,
        allowUserToCreateOrganization: true,
        organizationLimit: 10,
        membershipLimit: 200,
        organizationHooks: {
          afterCreateOrganization: async ({ organization: org, member }) => {
            await o.mirror?.organisation({ id: org.id, name: org.name });
            await o.mirror?.member({
              id: member.id,
              organizationId: org.id,
              userId: member.userId,
              role: member.role,
            });
          },
          afterUpdateOrganization: async ({ organization: org }) => {
            if (org) await o.mirror?.organisation({ id: org.id, name: org.name });
          },
          afterAddMember: async ({ member }) => {
            await o.mirror?.member({
              id: member.id,
              organizationId: member.organizationId,
              userId: member.userId,
              role: member.role,
            });
          },
          afterUpdateMemberRole: async ({ member }) => {
            await o.mirror?.member({
              id: member.id,
              organizationId: member.organizationId,
              userId: member.userId,
              role: member.role,
            });
          },
          afterRemoveMember: async ({ member }) => {
            await o.mirror?.memberRemoved({ id: member.id, organizationId: member.organizationId });
          },
          afterAcceptInvitation: async ({ member }) => {
            await o.mirror?.member({
              id: member.id,
              organizationId: member.organizationId,
              userId: member.userId,
              role: member.role,
            });
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof makeAuth>;

/**
 * Everything the API reads from its environment, checked once at start. Outside development the process
 * refuses to run with a default or short secret, so a copied compose file cannot go to production as is.
 */
import { z } from 'zod';

const DEV_SECRET = 'development-only-secret-change-me-32';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** The owner's connection, used by migrations. */
  DATABASE_URL: z.string().min(1),
  /** The app role's connection, used by requests; defaults to DATABASE_URL in development. */
  APP_DATABASE_URL: z.string().optional(),
  APP_DB_PASSWORD: z.string().optional(),
  REDIS_URL: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().default('gstdesk'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true'),
  /** Server-side encryption header on uploads; `none` for a MinIO without a key service. */
  S3_SSE: z.enum(['AES256', 'none']).default('AES256'),
  AUTH_SECRET: z.string().default(DEV_SECRET),
  /** Public base URL of the API, used for cookies and links. */
  BASE_URL: z.string().url().default('http://localhost:8787'),
  /** Origins allowed to use cookie sessions (the web app's origins), comma separated. */
  TRUSTED_ORIGINS: z.string().default('http://localhost:1420,http://localhost:4173'),
  OTP_PROVIDER: z.enum(['mock', 'msg91', 'log']).default('mock'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  EMAIL_FROM: z.string().default('GST Desk <no-reply@localhost>'),
  SMTP_URL: z.string().optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /** The organisation whose owners may see the internal admin pages. */
  INTERNAL_ORG_ID: z.string().optional(),
  RATE_LIMIT_IP_PER_MINUTE: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_ORG_PER_MINUTE: z.coerce.number().int().positive().default(1200),
  MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024),
  /** Behind a TLS proxy the client address is in X-Forwarded-For; otherwise that header is a client's claim. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  /** Where devices reach the PowerSync service, and the secret device tokens are signed with. */
  POWERSYNC_URL: z.string().url().optional(),
  POWERSYNC_JWT_SECRET: z.string().min(32).optional(),
});

export type Env = z.infer<typeof schema>;

export interface Config {
  env: Env['NODE_ENV'];
  port: number;
  databaseUrl: string;
  appDatabaseUrl: string;
  appDbPassword: string | undefined;
  redisUrl: string | undefined;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    pathStyle: boolean;
    sse: 'AES256' | null;
  } | null;
  authSecret: string;
  baseUrl: string;
  trustedOrigins: string[];
  otp: {
    provider: Env['OTP_PROVIDER'];
    msg91AuthKey?: string;
    msg91TemplateId?: string;
    emailFrom: string;
    smtpUrl?: string;
  };
  otelEndpoint: string | undefined;
  sentryDsn: string | undefined;
  logLevel: Env['LOG_LEVEL'];
  internalOrgId: string | undefined;
  limits: { ipPerMinute: number; orgPerMinute: number; maxBodyBytes: number };
  trustProxy: boolean;
  /** Sync is on when both the service address and the token secret are set. */
  sync: { powersyncUrl: string; jwtSecret: string } | null;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(raw: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConfigError(`bad environment: ${first?.path.join('.')} ${first?.message}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  if (production) {
    if (e.AUTH_SECRET === DEV_SECRET || e.AUTH_SECRET.length < 32)
      throw new ConfigError(
        'AUTH_SECRET must be set to at least 32 random characters in production',
      );
    if (!e.APP_DATABASE_URL)
      throw new ConfigError('APP_DATABASE_URL (the gst_app role) is required in production');
    if (e.OTP_PROVIDER === 'mock')
      throw new ConfigError('OTP_PROVIDER=mock is not allowed in production');
    if (!e.BASE_URL.startsWith('https://'))
      throw new ConfigError('BASE_URL must be https in production');
    if (e.S3_ACCESS_KEY === 'minioadmin' || e.S3_SECRET_KEY === 'minioadmin')
      throw new ConfigError('the default MinIO credentials are not allowed in production');
    if (e.S3_SSE === 'none')
      throw new ConfigError(
        'S3_SSE=none is not allowed in production: objects must be encrypted at rest',
      );
  }
  const s3 =
    e.S3_ENDPOINT && e.S3_ACCESS_KEY && e.S3_SECRET_KEY
      ? {
          endpoint: e.S3_ENDPOINT,
          region: e.S3_REGION,
          bucket: e.S3_BUCKET,
          accessKey: e.S3_ACCESS_KEY,
          secretKey: e.S3_SECRET_KEY,
          pathStyle: e.S3_FORCE_PATH_STYLE === 'true',
          sse: e.S3_SSE === 'none' ? null : ('AES256' as const),
        }
      : null;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    appDatabaseUrl: e.APP_DATABASE_URL ?? e.DATABASE_URL,
    appDbPassword: e.APP_DB_PASSWORD,
    redisUrl: e.REDIS_URL,
    s3,
    authSecret: e.AUTH_SECRET,
    baseUrl: e.BASE_URL,
    trustedOrigins: e.TRUSTED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    otp: {
      provider: e.OTP_PROVIDER,
      ...(e.MSG91_AUTH_KEY ? { msg91AuthKey: e.MSG91_AUTH_KEY } : {}),
      ...(e.MSG91_TEMPLATE_ID ? { msg91TemplateId: e.MSG91_TEMPLATE_ID } : {}),
      emailFrom: e.EMAIL_FROM,
      ...(e.SMTP_URL ? { smtpUrl: e.SMTP_URL } : {}),
    },
    otelEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
    sentryDsn: e.SENTRY_DSN,
    logLevel: e.LOG_LEVEL,
    internalOrgId: e.INTERNAL_ORG_ID,
    limits: {
      ipPerMinute: e.RATE_LIMIT_IP_PER_MINUTE,
      orgPerMinute: e.RATE_LIMIT_ORG_PER_MINUTE,
      maxBodyBytes: e.MAX_BODY_BYTES,
    },
    trustProxy: e.TRUST_PROXY === 'true',
    sync:
      e.POWERSYNC_URL && e.POWERSYNC_JWT_SECRET
        ? { powersyncUrl: e.POWERSYNC_URL, jwtSecret: e.POWERSYNC_JWT_SECRET }
        : null,
  };
}

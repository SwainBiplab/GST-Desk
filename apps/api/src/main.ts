/** The process: configuration, telemetry, database, auth, queues, the app, the HTTP server. */
import { serve } from '@hono/node-server';

import { createApp } from './app';
import { makeAuth } from './auth/auth';
import { mirrorInto } from './auth/mirror';
import { otpSender } from './auth/otp';
import { loadConfig } from './config';
import { migrateApi } from './db/migrate';
import { openPostgres } from './db/pool';
import { installErrorReporting } from './errors-reporting';
import { makeJobs } from './jobs/queues';
import { MemoryLimiter, RedisLimiter } from './limits';
import { makeLogger } from './log';
import { providersFrom } from './messaging/providers';
import { MessagingService } from './messaging/service';
import { enqueuer, startMessagingWorkers } from './messaging/worker';
import { PaymentsService } from './payments/service';
import { FcmSender } from './push/fcm';
import { makeNotifier } from './push/notify';
import { mountRoutes } from './routes';
import { makeStorage } from './storage/s3';
import { startTelemetry } from './telemetry';

const config = loadConfig(process.env);
const log = makeLogger(config.logLevel, config.env === 'development');
const telemetry = await startTelemetry(config, log);
installErrorReporting(config, log);

const adminDb = openPostgres(config.databaseUrl, { max: 2, appName: 'gst-api-migrate' });
const migrated = await migrateApi(adminDb, { appPassword: config.appDbPassword });
log.info({ shared: migrated.shared, api: migrated.api }, 'migrations');
await adminDb.close();

const db = openPostgres(config.appDatabaseUrl, { max: 10 });
const redis = config.redisUrl
  ? new (await import('ioredis')).default(config.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    })
  : null;
const otp = otpSender(config, log);
const auth = makeAuth({
  db: db.db,
  secret: config.authSecret,
  baseUrl: config.baseUrl,
  otp,
  trustedOrigins: config.trustedOrigins,
  mirror: mirrorInto(db),
});
const storage = makeStorage(config);
// the bucket and its lifecycle rules, made once; a store that refuses them still serves files
await storage
  ?.ensureBucket()
  .catch((e: unknown) => log.warn({ err: e }, 'could not prepare the bucket'));
const jobs = redis ? makeJobs(redis, log) : null;

const app = createApp({
  config,
  log,
  db,
  auth,
  ipLimiter: redis
    ? new RedisLimiter(redis, config.limits.ipPerMinute)
    : new MemoryLimiter(config.limits.ipPerMinute),
  orgLimiter: redis
    ? new RedisLimiter(redis, config.limits.orgPerMinute)
    : new MemoryLimiter(config.limits.orgPerMinute),
  telemetry,
  ready: async () => ({
    database: await db.sql`SELECT 1`.then(
      () => true,
      () => false,
    ),
    redis: redis
      ? await redis.ping().then(
          () => true,
          () => false,
        )
      : true,
    storage: storage ? await storage.ready() : true,
  }),
});
const notify = makeNotifier(
  db,
  config.fcm
    ? new FcmSender({
        project_id: config.fcm.projectId,
        client_email: config.fcm.clientEmail,
        private_key: config.fcm.privateKey,
      })
    : null,
  log,
);
const providers = providersFrom(config);
const messagingService = new MessagingService({ db, providers, log, enqueue: enqueuer(jobs) });
if (jobs) await startMessagingWorkers(jobs, messagingService, log);
const paymentsService = new PaymentsService({
  db,
  secretsKey: config.secretsKey,
  log,
  // a payment through the gateway gets the same receipt message as one recorded by hand
  onPaid: (a) =>
    messagingService.onApplied(a.orgId, 'system:gateway', {
      issued: [],
      payments: [{ id: a.paymentId, businessId: a.businessId, documentId: a.documentId }],
    }),
});
mountRoutes(app, {
  db,
  auth,
  storage,
  jobs,
  otp,
  config,
  notify,
  messaging: { service: messagingService, providers },
  payments: paymentsService,
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  log.info({ port: info.port, env: config.env }, 'gst-api listening');
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  server.close();
  await jobs?.close();
  await redis?.quit();
  await db.close();
  await telemetry.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

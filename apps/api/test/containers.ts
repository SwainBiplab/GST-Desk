/**
 * Real services for the integration tests, through Testcontainers: Postgres 16, Redis 7 and MinIO.
 * Each helper starts a container once per test file and hands back what the app needs. The images are
 * the ones `infra/docker-compose.yml` uses, so a test and a developer's stack see the same software.
 */
import { join } from 'node:path';

import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';

import { migrateApi } from '../src/db/migrate';
import { openPostgres, type PgDatabase } from '../src/db/pool';

export const IMAGES = {
  postgres: 'postgres:16.2-alpine',
  redis: 'redis:7-alpine',
  minio: 'minio/minio:latest',
  powersync: 'journeyapps/powersync-service:latest',
};

export interface PgStack {
  container: StartedTestContainer;
  /** The owner's connection (migrations). */
  adminUrl: string;
  /** The app role's connection (requests, with row-level security). */
  appUrl: string;
  admin: PgDatabase;
  app: PgDatabase;
  stop(): Promise<void>;
}

export async function startPostgres(): Promise<PgStack> {
  const container = await new GenericContainer(IMAGES.postgres)
    .withEnvironment({ POSTGRES_USER: 'owner', POSTGRES_PASSWORD: 'owner', POSTGRES_DB: 'gst' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const adminUrl = `postgres://owner:owner@${host}:${port}/gst`;
  const admin = openPostgres(adminUrl, { max: 2, appName: 'test-admin' });
  await migrateApi(admin, { appPassword: 'app' });
  const appUrl = `postgres://gst_app:app@${host}:${port}/gst`;
  const app = openPostgres(appUrl, { max: 4, appName: 'test-app' });
  return {
    container,
    adminUrl,
    appUrl,
    admin,
    app,
    stop: async () => {
      await app.close();
      await admin.close();
      await container.stop();
    },
  };
}

export interface RedisStack {
  container: StartedTestContainer;
  url: string;
  stop(): Promise<void>;
}

export async function startRedis(): Promise<RedisStack> {
  const container = await new GenericContainer(IMAGES.redis)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  return {
    container,
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: () => container.stop().then(() => undefined),
  };
}

export interface MinioStack {
  container: StartedTestContainer;
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop(): Promise<void>;
}

export async function startMinio(): Promise<MinioStack> {
  const container = await new GenericContainer(IMAGES.minio)
    .withEnvironment({ MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();
  return {
    container,
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
    stop: () => container.stop().then(() => undefined),
  };
}

export interface SyncStack extends PgStack {
  network: StartedNetwork;
  powersync: StartedTestContainer;
  /** Where devices connect for the download stream. */
  powersyncUrl: string;
  /** The HS256 secret the API signs device tokens with. */
  jwtSecret: string;
}

/**
 * Postgres with logical replication, the API's schema and publication, and the PowerSync service
 * replicating from it with the generated sync rules. Devices (the tests' Node clients) connect to
 * `powersyncUrl` for downloads and upload through the API in process.
 */
export async function startSyncStack(): Promise<SyncStack> {
  const network = await new Network().start();
  const container = await new GenericContainer(IMAGES.postgres)
    .withNetwork(network)
    .withNetworkAliases('pg')
    .withEnvironment({ POSTGRES_USER: 'owner', POSTGRES_PASSWORD: 'owner', POSTGRES_DB: 'gst' })
    .withCommand([
      'postgres',
      '-c',
      'wal_level=logical',
      '-c',
      'max_replication_slots=10',
      '-c',
      'max_wal_senders=10',
    ])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const adminUrl = `postgres://owner:owner@${host}:${port}/gst`;
  const admin = openPostgres(adminUrl, { max: 2, appName: 'test-admin' });
  await migrateApi(admin, { appPassword: 'app' });
  await admin.sql.unsafe('CREATE DATABASE powersync_storage');
  const appUrl = `postgres://gst_app:app@${host}:${port}/gst`;
  const app = openPostgres(appUrl, { max: 6, appName: 'test-app' });

  const jwtSecret = 'sync-test-secret-'.padEnd(48, 'x');
  const k = Buffer.from(jwtSecret).toString('base64url');
  const infra = join(import.meta.dirname, '..', '..', '..', 'infra', 'powersync');
  const powersync = await new GenericContainer(IMAGES.powersync)
    .withNetwork(network)
    .withCopyFilesToContainer([
      { source: join(infra, 'powersync.yaml'), target: '/config/powersync.yaml' },
      { source: join(infra, 'sync-rules.yaml'), target: '/config/sync-rules.yaml' },
    ])
    .withEnvironment({
      POWERSYNC_CONFIG_PATH: '/config/powersync.yaml',
      PS_REPLICATION_URI: 'postgres://owner:owner@pg:5432/gst',
      PS_STORAGE_URI: 'postgres://owner:owner@pg:5432/powersync_storage',
      PS_JWT_SECRET_B64URL: k,
      NODE_OPTIONS: '--max-old-space-size=1000',
    })
    .withCommand(['start', '-r', 'unified'])
    .withExposedPorts(8080)
    // up, and the sync rules loaded and replicating (before that, devices get 'no sync config')
    .withWaitStrategy(
      Wait.forAll([
        Wait.forHttp('/probes/liveness', 8080),
        Wait.forLogMessage(/Activated new replication stream/),
      ]).withStartupTimeout(120_000),
    )
    .start();
  return {
    container,
    network,
    powersync,
    powersyncUrl: `http://${powersync.getHost()}:${powersync.getMappedPort(8080)}`,
    jwtSecret,
    adminUrl,
    appUrl,
    admin,
    app,
    stop: async () => {
      await app.close();
      await admin.close();
      await powersync.stop();
      await container.stop();
      await network.stop();
    },
  };
}

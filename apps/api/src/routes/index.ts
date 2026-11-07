/** Mount every route group under `/v1`. The auth handler is better-auth's own. */
import type { App } from '../app';
import type { Auth } from '../auth/auth';
import type { OtpSender } from '../auth/auth';
import type { Config } from '../config';
import type { PgDatabase } from '../db/pool';
import type { FilingService } from '../filing/service';
import type { Jobs } from '../jobs/queues';
import type { providersFrom } from '../messaging/providers';
import type { MessagingService } from '../messaging/service';
import { readSession } from '../middleware/session';
import type { PaymentsService } from '../payments/service';
import type { ExportPackService } from '../portals/export-pack';
import type { PortalService } from '../portals/links';
import type { ShareService } from '../portals/shares';
import type { Notifier } from '../push/notify';
import type { Storage } from '../storage/s3';

import { adminRoutes } from './admin';
import { devRoutes } from './dev';
import { fileRoutes } from './files';
import { filingRoutes } from './filing';
import { meRoutes } from './me';
import { messagingRoutes } from './messaging';
import { orgRoutes } from './orgs';
import { paymentsRoutes } from './payments';
import { portalRoutes } from './portal';
import { pushRoutes } from './push';
import { sharingRoutes } from './sharing';
import { syncRoutes } from './sync';
import { teamRoutes } from './team';
import { webhookRoutes } from './webhooks';

export interface RouteDeps {
  db: PgDatabase;
  auth: Auth;
  storage: Storage | null;
  jobs: Jobs | null;
  otp: OtpSender;
  config: Config;
  /** Push to phones; absent when FCM is not configured. */
  notify?: Notifier;
  /** Cloud-tier messaging (prompt 44): the service and the providers it sends through. */
  messaging?: { service: MessagingService; providers: ReturnType<typeof providersFrom> };
  /** Payment links, UPI QR and reconciliation (prompt 45). */
  payments?: PaymentsService;
  /** GST filing through the GSP: portal login, push, pull, the CA board (prompt 46). */
  filing?: FilingService;
  /** Sharing with an accountant, the customer's pages and export packs (prompt 47). */
  portals?: { shares: ShareService; links: PortalService; packs: ExportPackService };
}

export function mountRoutes(app: App, deps: RouteDeps): void {
  // better-auth: /v1/auth/* (sign-in by email or phone code, sessions, organisations, two-factor)
  // better-auth's organisation endpoints are closed: membership, roles and invitations go through the
  // team routes, which check the shared permission matrix (an admin cannot make an owner there)
  app.all('/v1/auth/organization/*', (c) =>
    c.json({ error: { code: 'not_found', message: 'Use the team routes under /v1/orgs.' } }, 404),
  );
  app.on(['GET', 'POST'], '/v1/auth/*', (c) => deps.auth.handler(c.req.raw));
  app.use('/v1/*', readSession);
  meRoutes(app, deps);
  orgRoutes(app, deps);
  fileRoutes(app, deps);
  syncRoutes(app, deps);
  teamRoutes(app, deps);
  pushRoutes(app, deps);
  messagingRoutes(app, deps);
  paymentsRoutes(app, deps);
  filingRoutes(app, deps);
  sharingRoutes(app, deps);
  portalRoutes(app, deps);
  webhookRoutes(app, deps);
  adminRoutes(app, deps);
  if (deps.config.env !== 'production') devRoutes(app, deps);
}

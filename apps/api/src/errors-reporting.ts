/**
 * Error reporting to a Sentry-compatible endpoint, on only when a DSN is set. Every message and
 * breadcrumb is scrubbed of emails, phones, GSTINs, PANs and long numbers before it leaves; request
 * bodies and headers are never attached.
 */
import * as Sentry from '@sentry/node';
import type { Logger } from 'pino';

import type { Config } from './config';
import { scrub } from './log';

function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  if (event.message) event.message = scrub(event.message);
  for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = scrub(ex.value);
  for (const b of event.breadcrumbs ?? []) if (b.message) b.message = scrub(b.message);
  delete event.request;
  delete event.user;
  return event;
}

export function installErrorReporting(config: Config, log: Logger): void {
  if (!config.sentryDsn) return;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.env,
    release: `gst-api@0.1.0`,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (b) => (b.message ? { ...b, message: scrub(b.message) } : b),
  });
  log.info('error reporting on');
}

export const reportError = (err: unknown, context: Record<string, string> = {}): void => {
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(context)) scope.setTag(k, scrub(v));
    Sentry.captureException(err);
  });
};

export { scrubEvent };

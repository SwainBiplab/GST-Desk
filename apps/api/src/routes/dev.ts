/**
 * Development only (never mounted in production): the last one-time code sent to an address, so a
 * client can be tried without a mailbox or a phone, and the tests can sign in.
 */
import { createRoute, z } from '@hono/zod-openapi';

import type { App } from '../app';
import type { MockOtpSender } from '../auth/otp';
import { errorSchema, notFound } from '../errors';

import type { RouteDeps } from './index';

export function devRoutes(app: App, deps: RouteDeps): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/dev/otp',
      tags: ['dev'],
      summary: 'Development only: the last one-time code sent to an email address or phone number',
      request: { query: z.object({ to: z.string().min(3).max(200) }) },
      responses: {
        200: {
          description: 'The code',
          content: {
            'application/json': { schema: z.object({ to: z.string(), code: z.string() }) },
          },
        },
        404: {
          description: 'No code was sent there',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    (c) => {
      const { to } = c.req.valid('query');
      const sender = deps.otp as Partial<MockOtpSender>;
      const code = sender.last?.(to);
      if (!code) throw notFound('A code for that address');
      return c.json({ to, code }, 200);
    },
  );
}

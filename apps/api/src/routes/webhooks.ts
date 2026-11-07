/**
 * The providers' webhooks (prompt 44): public addresses, so each request proves who it is from. The raw body is
 * checked against the provider's signature before anything is read from it, an event is applied once however
 * many times it arrives, and the answer is quick (the status is on the message when the response is sent).
 */
import type { App } from '../app';
import { ApiError } from '../errors';

import type { RouteDeps } from './index';

export function webhookRoutes(app: App, deps: RouteDeps): void {
  const headersOf = (c: { req: { header(): Record<string, string> } }) =>
    Object.fromEntries(Object.entries(c.req.header()).map(([k, v]) => [k.toLowerCase(), v]));

  // The payment gateway (prompt 45). Each business has its own account and webhook secret, so the address names
  // the gateway row; an unknown or disconnected one is a 404, a wrong signature a 401, and neither stores anything.
  const pay = deps.payments;
  if (pay)
    app.post('/v1/webhooks/razorpay/:gatewayId', async (c) => {
      const key = await pay.webhookKey(c.req.param('gatewayId'));
      if (!key) throw new ApiError(404, 'not_found', 'Not configured.');
      const raw = await c.req.text();
      const h = headersOf(c as never);
      if (!key.gw.verifyWebhook(h, raw))
        throw new ApiError(401, 'bad_signature', 'The signature does not match.');
      const events = key.gw.parseWebhook(raw, h);
      const r = await pay.applyEvents(key.orgId, key.businessId, c.req.param('gatewayId'), events);
      return c.json(r, 200);
    });

  const m = deps.messaging;
  if (!m) return;

  // Meta confirms the address by calling it with a challenge when the webhook is saved
  app.get('/v1/webhooks/whatsapp', (c) => {
    const wa = m.providers.whatsappLive;
    if (!wa) throw new ApiError(404, 'not_found', 'Not configured.');
    const answer = wa.verifyChallenge({
      mode: c.req.query('hub.mode') ?? null,
      token: c.req.query('hub.verify_token') ?? null,
      challenge: c.req.query('hub.challenge') ?? null,
    });
    if (answer === null) throw new ApiError(403, 'forbidden', 'The verify token does not match.');
    return c.text(answer, 200);
  });

  app.post('/v1/webhooks/whatsapp', async (c) => {
    const wa = m.providers.whatsappLive;
    if (!wa) throw new ApiError(404, 'not_found', 'Not configured.');
    const raw = await c.req.text();
    if (!wa.verifyWebhook(headersOf(c as never), raw))
      throw new ApiError(401, 'bad_signature', 'The signature does not match.');
    const r = await m.service.applyEvents('whatsapp', wa.parseWebhook(raw));
    return c.json(r, 200);
  });

  app.post('/v1/webhooks/resend', async (c) => {
    const rs = m.providers.resendLive;
    if (!rs) throw new ApiError(404, 'not_found', 'Not configured.');
    const raw = await c.req.text();
    const h = headersOf(c as never);
    if (!rs.verifyWebhook(h, raw))
      throw new ApiError(401, 'bad_signature', 'The signature does not match.');
    const r = await m.service.applyEvents('resend', rs.parseWebhook(raw, h));
    return c.json(r, 200);
  });
}

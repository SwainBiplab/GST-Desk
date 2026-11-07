import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

/**
 * Prompt 44. The Messages tab talks to the cloud API; a small fake answers in the browser (Playwright routes).
 * The API, the providers' adapters and the reminder and recurring rules are tested in `apps/api` and
 * `packages/messaging`. Real WhatsApp and Resend sends are in `docs/qa/messaging-sandbox.md` (not run).
 */
const API = 'http://localhost:9999';

interface Fake {
  calls: { method: string; path: string; body: unknown }[];
  outbox: Record<string, unknown>[];
  log: Record<string, unknown>[];
}

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg-1',
  party_id: 'p1',
  document_id: 'd1',
  kind: 'invoice',
  channel: 'whatsapp',
  to_address: '+919876543210',
  language: 'en',
  subject: null,
  body: 'Hello Asha, invoice INV/26-27/0001 for Rs 1,180 is ready.',
  created_at: 1,
  ...over,
});

async function fakeApi(page: Page): Promise<Fake> {
  const fake: Fake = { calls: [], outbox: [message()], log: [] };
  await page.addInitScript((api) => {
    localStorage.setItem(
      'cloud.session',
      JSON.stringify({ baseUrl: api, token: 't', email: 'asha@example.com', signedInAt: 1 }),
    );
  }, API);
  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : null;
    fake.calls.push({ method: req.method(), path, body });
    const json = (v: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(v) });
    if (path === '/v1/me')
      return json({
        user: { id: 'u1', email: 'asha@example.com', phone: null, name: 'Asha', locale: 'en' },
        organisations: [{ id: 'org-1', name: 'Asha Traders', role: 'owner' }],
        activeOrganizationId: null,
      });
    if (/\/permissions$/.test(path))
      return json({ memberId: 'm1', permissions: { role: 'owner', grants: {} }, policy: {} });
    if (path.endsWith('/messaging/status'))
      return json({
        plan: 'cloud',
        enabled: true,
        used: 12,
        limit: 1000,
        channels: { whatsapp: true, email: true },
      });
    if (path.includes('/messaging/settings/')) {
      if (req.method() === 'PUT') return json(body);
      return json({
        onIssue: { tax_invoice: true },
        onPayment: true,
        reminders: true,
        offsets: [-3, 0, 7, 15],
        quietStart: '21:00',
        quietEnd: '09:00',
        autoSend: {},
        channel: 'whatsapp_first',
        defaultLanguage: 'en',
      });
    }
    if (path.endsWith('/messaging/templates'))
      return json([
        {
          id: 't1',
          kind: 'invoice',
          language: 'en',
          name: 'gd_x_invoice',
          body: 'Hello {{1}}, your invoice {{2}} is ready.',
          status: 'approved',
          reason: null,
        },
      ]);
    if (path.endsWith('/messaging/outbox')) return json(fake.outbox);
    if (/\/messages\/[^/]+\/approve$/.test(path)) {
      fake.outbox = [];
      fake.log = [
        {
          ...message(),
          status: 'delivered',
          approval: 'approved',
          error: null,
          timeline: [
            { status: 'queued', detail: null, at: 1 },
            { status: 'sent', detail: null, at: 2 },
            { status: 'delivered', detail: null, at: 3 },
          ],
        },
      ];
      return json({ id: 'msg-1' });
    }
    if (path.endsWith('/messaging/log')) return json(fake.log);
    if (path.endsWith('/recurring-invoices')) return json([]);
    return json({});
  });
  return fake;
}

test.describe('messages', () => {
  test('approve a waiting message and see it delivered', async ({ page }) => {
    const fake = await fakeApi(page);
    await openSeeded(page, '/books/settings?tab=messages');
    await expect(page.getByTestId('dispatch-status')).toContainText('12 of 1000');
    await expect(page.getByTestId('outbox-row')).toHaveCount(1);
    await expect(page.getByTestId('outbox-body')).toContainText('INV/26-27/0001');

    await page.getByTestId('outbox-approve').click();
    await expect(page.getByTestId('outbox-empty')).toBeVisible();
    expect(fake.calls.some((c) => c.method === 'POST' && c.path.endsWith('/msg-1/approve'))).toBe(
      true,
    );
    await expect(page.getByTestId('message-status').first()).toContainText('Delivered', {
      timeout: 10_000,
    });
  });

  test('edit the text before sending, and refuse a bad reminder offset list', async ({ page }) => {
    const fake = await fakeApi(page);
    await openSeeded(page, '/books/settings?tab=messages');
    await page.getByTestId('outbox-edit').click();
    await page.getByTestId('outbox-text').fill('Edited text for Asha');
    await page.getByTestId('outbox-send-edited').click();
    const call = fake.calls.find((c) => c.path.endsWith('/msg-1/approve'));
    expect(call?.body).toEqual({ body: 'Edited text for Asha' });

    await page.getByTestId('rule-offsets').fill('soon');
    await expect(page.getByTestId('rules-save')).toBeDisabled();
    await page.getByTestId('rule-offsets').fill('-2, 0, 5');
    await page.getByTestId('rule-auto-reminder').click();
    await page.getByTestId('rules-save').click();
    await expect
      .poll(() => fake.calls.find((c) => c.method === 'PUT' && c.path.includes('/settings/'))?.body)
      .toMatchObject({ offsets: [-2, 0, 5], autoSend: { reminder: true } });
  });

  test('an issued invoice: send it by message and make it repeat', async ({ page }) => {
    const fake = await fakeApi(page);
    await openSeeded(page, '/books/documents');
    await page.getByTestId('doc-filter-status').click();
    await page.getByRole('option', { name: 'Issued', exact: true }).first().click();
    await page.getByTestId('document-open').first().click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();

    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-send-message').click();
    await expect
      .poll(
        () =>
          fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/messaging/send'))?.body,
      )
      .toMatchObject({ kind: 'invoice' });

    // the dialog stays open after the menu closes
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-repeat').click();
    await expect(page.getByTestId('repeat-dialog')).toBeVisible();
    await page.getByTestId('repeat-frequency').selectOption('weekly');
    await page.getByTestId('repeat-send').click();
    await page.getByTestId('repeat-save').click();
    await expect
      .poll(
        () =>
          fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/recurring-invoices'))
            ?.body,
      )
      .toMatchObject({ frequency: 'weekly', send: true });
    await expect(page.getByTestId('repeat-dialog')).toHaveCount(0);
  });

  test('templates show their status', async ({ page }) => {
    await fakeApi(page);
    await openSeeded(page, '/books/settings?tab=messages');
    await expect(page.getByTestId('template-invoice-en')).toContainText('Approved');
  });
});

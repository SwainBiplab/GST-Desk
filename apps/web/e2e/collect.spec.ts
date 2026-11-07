import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

/**
 * Prompt 45. The Online payments tab, the invoice's payment link and the full-screen QR talk to the cloud API;
 * a small fake answers in the browser. The API (signed webhooks, allocation, the fee in the ledger, replays,
 * refunds) is tested against Postgres in `apps/api/test/payments.test.ts`, and the gateway adapter against
 * fixtures in `packages/payments`. A real Razorpay test-mode payment is in `docs/qa/payments-sandbox.md` (not run).
 */
const API = 'http://localhost:9999';

interface Fake {
  calls: { method: string; path: string; body: unknown }[];
  connected: boolean;
  paid: boolean;
}

async function fakeApi(page: Page): Promise<Fake> {
  const fake: Fake = { calls: [], connected: false, paid: false };
  await page.addInitScript((api) => {
    localStorage.setItem(
      'cloud.session',
      JSON.stringify({ baseUrl: api, token: 't', email: 'asha@example.com', signedInAt: 1 }),
    );
  }, API);
  const request = (kind: 'link' | 'qr') => ({
    id: `req-${kind}`,
    documentId: 'd1',
    kind,
    url:
      kind === 'link'
        ? 'https://rzp.io/i/abc123'
        : 'upi://pay?pa=rzp@icici&pn=Demo&am=1180.00&cu=INR',
    imageUrl: null,
    amountPaise: 118000,
    paidPaise: fake.paid ? 118000 : 0,
    partialAllowed: false,
    expiresAt: Date.now() + 86_400_000,
    status: fake.paid ? 'paid' : 'created',
  });
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
    if (path.endsWith('/payments/gateway')) {
      if (req.method() === 'PUT') fake.connected = true;
      return json({
        connected: fake.connected,
        configured: true,
        provider: fake.connected ? 'razorpay' : null,
        mode: fake.connected ? 'test' : null,
        active: fake.connected,
        keyId: fake.connected ? 'rzp_test_abc123XYZ' : null,
        lastError: null,
        lastOkAt: null,
        webhookPath: fake.connected ? '/v1/webhooks/razorpay/gw-1' : null,
      });
    }
    if (path.endsWith('/payments/requests') && req.method() === 'POST')
      return json(request((body?.['kind'] as 'link' | 'qr') ?? 'link'), 201);
    if (path.endsWith('/payments/requests')) return json([]);
    if (/\/payments\/requests\/req-/.test(path))
      return json(request(path.endsWith('qr') ? 'qr' : 'link'));
    if (path.endsWith('/payments/online'))
      return json([
        {
          id: 'gp1',
          providerPaymentId: 'pay_1',
          documentId: 'd1',
          partyId: 'p1',
          amountPaise: 118000,
          feePaise: 2784,
          refundedPaise: 0,
          method: 'upi',
          status: 'matched',
          settlementId: null,
          at: Date.now(),
        },
      ]);
    if (path.endsWith('/payments/settlements')) return json([]);
    if (path.endsWith('/payments/refunds')) return json([]);
    return json({});
  });
  return fake;
}

test.describe('collect online', () => {
  test('connect a gateway, see what was paid online with its fee', async ({ page }) => {
    const fake = await fakeApi(page);
    await openSeeded(page, '/books/settings?tab=collect');
    await expect(page.getByTestId('collect-connect')).toBeDisabled();
    await page.getByTestId('collect-keyId').fill('rzp_test_abc123XYZ');
    await page.getByTestId('collect-keySecret').fill('super-secret-key');
    await page.getByTestId('collect-webhookSecret').fill('hook-secret');
    await page.getByTestId('collect-connect').click();
    await expect(page.getByTestId('collect-connected')).toContainText('rzp_test_abc123XYZ');
    await expect(page.getByTestId('collect-connected')).toContainText('Test mode');
    await expect(page.getByTestId('collect-webhook')).toHaveValue(
      `${API}/v1/webhooks/razorpay/gw-1`,
    );
    expect(
      fake.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/payments/gateway'))?.body,
    ).toMatchObject({ keyId: 'rzp_test_abc123XYZ', keySecret: 'super-secret-key' });
    // the secret is never put back on screen
    await expect(page.getByTestId('collect-tab')).not.toContainText('super-secret-key');
    await expect(page.getByTestId('online-row')).toContainText('₹1,180.00');
    await expect(page.getByTestId('online-row')).toContainText('fee ₹27.84');
  });

  test('an issued invoice: make the link, then show the QR, which turns to Paid by itself', async ({
    page,
  }) => {
    const fake = await fakeApi(page);
    fake.connected = true;
    await openSeeded(page, '/books/documents');
    await page.getByTestId('doc-filter-status').click();
    await page.getByRole('option', { name: 'Issued', exact: true }).first().click();
    await page.getByTestId('document-open').first().click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();

    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-collect').click();
    await page.getByTestId('collect-partial').click();
    await page.getByTestId('collect-make').click();
    await expect(page.getByTestId('collect-url')).toHaveValue('https://rzp.io/i/abc123');
    expect(
      fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/payments/requests'))?.body,
    ).toMatchObject({ kind: 'link', partialAllowed: true });
    await page.keyboard.press('Escape');

    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-show-qr').click();
    await expect(page.getByTestId('upi-qr')).toBeVisible();
    await expect(page.getByTestId('show-qr-amount')).toContainText('₹1,180.00');
    await expect(page.getByTestId('show-qr-paid')).toHaveCount(0);
    fake.paid = true; // the gateway's webhook has been applied
    await expect(page.getByTestId('show-qr-paid')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('show-qr-close').click();
    await expect(page.getByTestId('show-qr')).toHaveCount(0);
  });

  test('a free book with no cloud session is not offered any of it', async ({ page }) => {
    await openSeeded(page, '/books/documents');
    await page.getByTestId('doc-filter-status').click();
    await page.getByRole('option', { name: 'Issued', exact: true }).first().click();
    await page.getByTestId('document-open').first().click();
    await page.getByTestId('doc-more').click();
    await expect(page.getByTestId('doc-pdf')).toBeVisible();
    await expect(page.getByTestId('doc-collect')).toHaveCount(0);
    await expect(page.getByTestId('doc-show-qr')).toHaveCount(0);
  });
});

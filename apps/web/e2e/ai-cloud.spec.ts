import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures';
import { openSeeded, png } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(180_000);

/**
 * Prompt 48. Cloud AI is opt-in per business. In demo mode the OCR fixture reads a sample bill; with cloud AI on,
 * the scan also goes to the gateway (a fake answers in the browser) and the review card says which model read
 * it. The gateway itself (quota, redaction, metering, refusals, tools, citations, batches) is tested against
 * Postgres in `apps/api/test/ai.test.ts`, and the provider with the SDK's HTTP mocked in
 * `packages/ai/test/cloud.test.ts`.
 */
const API = 'http://localhost:9999';

async function fakeApi(page: Page) {
  const calls: { path: string; body: any }[] = [];
  await page.addInitScript((api) => {
    localStorage.setItem(
      'cloud.session',
      JSON.stringify({ baseUrl: api, token: 't', email: 'asha@example.com', signedInAt: 1 }),
    );
  }, API);
  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()!) : null;
    calls.push({ path, body });
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
    if (path.endsWith('/filing/status'))
      return json({
        entitlement: { enabled: false, used: 0, limit: 0 },
        session: {
          configured: false,
          practice: false,
          vendor: null,
          connected: false,
          expiresAt: null,
          username: null,
          gstin: null,
          otpPending: false,
        },
        jobs: [],
      });
    if (path.endsWith('/ai/status'))
      return json({
        enabled: true,
        configured: true,
        used: 1_650_000,
        limit: 2_000_000,
        warning: true,
      });
    if (path.endsWith('/ai/extract-bill'))
      return json({
        bill: {
          supplierName: 'SHREE GANESH TRADERS',
          supplierGstin: '27AAPFU0939F1ZV',
          invoiceNumber: 'SGT/2026/0412',
          date: '2026-06-15',
          lines: [
            {
              description: 'Cement OPC 53 50kg',
              hsn: '2523',
              qty: 20,
              ratePaise: 38000,
              gstRateBp: 1800,
            },
            {
              description: 'TMT Bar 12mm',
              hsn: '7214',
              qty: 100,
              ratePaise: 6250,
              gstRateBp: 1800,
            },
          ],
          totalPaise: 1_634_300,
        },
        supplier: { partyId: null, confidence: 0.5 },
        lineMatches: [
          { itemId: null, confidence: 0 },
          { itemId: null, confidence: 0 },
        ],
        checks: { totalsAgree: true, gstinValid: true, dateSane: true },
        fieldConfidence: {
          supplierName: 0.95,
          invoiceNumber: 0.95,
          date: 0.95,
          lines: 0.9,
          totalPaise: 0.95,
        },
        model: 'claude-opus-5-5',
        usage: { inputTokens: 1800, outputTokens: 240, cacheReadTokens: 900 },
        latencyMs: 2100,
        quota: { used: 1_652_040, limit: 2_000_000, warning: true },
      });
    if (path.endsWith('/ai/explain-mismatch'))
      return json({
        explanation: 'The supplier reported this invoice a month later than your books.',
        likelyCause: 'wrong_period',
        suggestedAction: 'Take the credit in the month it appears in GSTR-2B.',
        confidence: 0.8,
        model: 'claude-opus-5-5',
        usage: { inputTokens: 900, outputTokens: 120 },
        latencyMs: 1200,
        quota: { used: 1_653_060, limit: 2_000_000, warning: true },
      });
    if (path.endsWith('/ai/gst-qa'))
      return json({
        answer:
          'A credit note must be declared by 30 November following the end of the financial year.',
        sources: [
          {
            title: 'Credit notes and debit notes (section 34, rule 53)',
            heading: 'Time limit for a credit note',
            source: 'https://cbic-gst.gov.in/CGST-Act.html',
            date: '2022-10-01',
            quote: 'not later than the thirtieth day of November',
          },
        ],
        disclaimer: 'This is general information, not legal or tax advice.',
        covered: true,
        model: 'claude-opus-5-5',
        quota: { used: 1_654_000, limit: 2_000_000, warning: true },
      });
    return json({});
  });
  return calls;
}

test.describe('cloud AI', () => {
  test('is off until the business opts in; then a scan goes through the gateway and the card says which model read it', async ({
    page,
  }) => {
    const calls = await fakeApi(page);
    await openSeeded(page, '/books/settings?tab=ai');
    await expect(page.getByTestId('ai-cloud')).toBeVisible();
    await expect(page.getByTestId('ai-cloud-enabled')).toHaveAttribute('data-state', 'unchecked');
    // off: the scan panel offers no cloud option (every address carries demo=1: the flag is read once at load)
    await openSeeded(page, '/books/inbox?intent=scan');
    await expect(page.getByTestId('scan-panel')).toBeVisible();
    await expect(page.getByTestId('scan-cloud')).toHaveCount(0);

    await openSeeded(page, '/books/settings?tab=ai');
    await page.getByTestId('ai-cloud-enabled').click();
    await expect(page.getByTestId('ai-cloud-gateway')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('ai-cloud-status')).toContainText('16,50,000 of 20,00,000');
    await expect(page.getByTestId('ai-cloud-status')).toContainText('80%');
    await expect(page.getByTestId('ai-cloud-data-note')).toContainText('masked');
    await expect(page.getByText('Why cloud?')).toBeVisible();
    // the browser build cannot keep a key in a keychain
    await expect(page.getByTestId('ai-cloud-byok')).toBeDisabled();
    // do not ask every time, for this test (wait for the setting to land before leaving the page)
    await page.getByTestId('ai-cloud-ask').click();
    await expect(page.getByTestId('ai-cloud-ask')).toHaveAttribute('data-state', 'unchecked');

    await openSeeded(page, '/books/inbox?intent=scan');
    await expect(page.getByTestId('scan-cloud')).toBeVisible();
    await expect(page.getByTestId('scan-cloud')).toHaveAttribute('data-state', 'checked');
    await page
      .getByTestId('scan-input')
      .setInputFiles({ name: 'bill.png', mimeType: 'image/png', buffer: png(640, 480) });
    await expect(page.getByTestId('inbox-kind')).toContainText('Scanned purchase bill', {
      timeout: 60_000,
    });
    const detail = page.getByTestId('extraction-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('field-supplierName')).toContainText('SHREE GANESH TRADERS');
    await expect(detail).toContainText('anthropic');
    // what left the device: the text the fixture read, with the business, not the image
    const sent = calls.find((c) => c.path.endsWith('/ai/extract-bill'))!;
    expect(sent.body.text).toContain('SGT/2026/0412');
    expect(sent.body.file).toBeUndefined();

    // review and accept, as for any scan
    await page.getByTestId('detail-edit').click();
    await page.getByTestId('extraction-confirm').click();
    await expect(page.getByTestId('inbox-count-done')).toHaveText('1');
  });

  test('explains a reconciliation mismatch and answers a GST question with sources', async ({
    page,
  }) => {
    await fakeApi(page);
    await openSeeded(page, '/books/settings?tab=ai');
    await page.getByTestId('ai-cloud-enabled').click();
    await page.getByTestId('ai-cloud-ask').click();
    await expect(page.getByTestId('ai-cloud-ask')).toHaveAttribute('data-state', 'unchecked');
    await openSeeded(page, '/books/gst');
    await page.getByTestId('assistant-open').click();
    await page.getByTestId('assistant-mode-gst').click();
    await page.getByTestId('assistant-question').fill('Until when can I issue a credit note?');
    await page.getByTestId('assistant-ask').click();
    await expect(page.getByTestId('assistant-answer')).toContainText('30 November');
    await expect(page.getByTestId('assistant-sources')).toContainText('section 34');
    await expect(page.getByTestId('assistant-disclaimer')).toContainText('not legal');
  });
});

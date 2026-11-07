import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

/**
 * Prompt 46. The Filing Desk's portal login and portal tab, and the CA board, talk to the cloud API; a small fake
 * answers in the browser. The API (OTP session sealed at rest, push, partial failure, expiry, 2B pull into
 * reconciliation, ARN and period lock, metering, the board across organisations) is tested against Postgres in
 * `apps/api/test/filing.test.ts`. A real vendor sandbox run is in `docs/compliance/gsp-sandbox-run.md` (not run).
 */
const API = 'http://localhost:9999';

interface Fake {
  calls: { method: string; path: string; body: unknown }[];
  connected: boolean;
  otpPending: boolean;
  jobs: Record<string, unknown>[];
}

async function fakeApi(page: Page): Promise<Fake> {
  const fake: Fake = { calls: [], connected: false, otpPending: false, jobs: [] };
  await page.addInitScript((api) => {
    localStorage.setItem(
      'cloud.session',
      JSON.stringify({ baseUrl: api, token: 't', email: 'ca@example.com', signedInAt: 1 }),
    );
  }, API);
  const session = () => ({
    configured: true,
    practice: true,
    vendor: 'practice',
    connected: fake.connected,
    expiresAt: Date.now() + 6 * 3_600_000,
    username: 'asha.api',
    gstin: '27AABCD1234E1Z8',
    otpPending: fake.otpPending,
  });
  let polls = 0;
  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : null;
    fake.calls.push({ method: req.method(), path, body });
    const json = (v: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(v) });
    if (path === '/v1/me')
      return json({
        user: { id: 'u1', email: 'ca@example.com', phone: null, name: 'CA', locale: 'en' },
        organisations: [{ id: 'org-1', name: 'Asha Traders', role: 'owner' }],
        activeOrganizationId: null,
      });
    if (/\/permissions$/.test(path))
      return json({ memberId: 'm1', permissions: { role: 'owner', grants: {} }, policy: {} });
    if (path.endsWith('/filing/status'))
      return json({
        entitlement: { enabled: true, used: 3, limit: 1000 },
        session: session(),
        jobs: [],
      });
    if (path.endsWith('/filing/otp') && req.method() === 'POST') {
      fake.otpPending = true;
      return json(session());
    }
    if (path.endsWith('/filing/otp/verify')) {
      if (body?.['otp'] !== '123456')
        return json({ error: { code: 'filing_portal', message: 'Invalid OTP (AUTH4033)' } }, 502);
      fake.connected = true;
      fake.otpPending = false;
      return json(session());
    }
    if (path.endsWith('/filing/session')) {
      fake.connected = false;
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith('/filing/jobs') && req.method() === 'POST') {
      const kind = String(body?.['kind']);
      const job = {
        id: `job-${fake.jobs.length + 1}`,
        businessId: 'b1',
        kind,
        form: body?.['form'] ?? null,
        period: body?.['period'],
        status: kind === 'push' ? 'processing' : 'done',
        reference: kind === 'push' ? 'REF-000001' : null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result:
          kind === 'push'
            ? { tables: [{ table: 'b2b', status: 'ok', count: 4, errors: [] }] }
            : kind === 'pull_2b'
              ? { imported: 12, matched: 9, withDifferences: 2, onlyIn2b: 1 }
              : { filed: true, arn: 'AA2710260001A1Z', filedOn: '2026-11-10' },
      };
      fake.jobs.unshift(job);
      polls = 0;
      return json({ id: job.id, existing: false }, 202);
    }
    if (path.endsWith('/filing/jobs')) {
      polls++;
      // the portal finishes processing an upload after it has been asked about once
      if (polls > 1)
        for (const j of fake.jobs) if (j['status'] === 'processing') j['status'] = 'done';
      return json(fake.jobs);
    }
    if (path.endsWith('/filing/desk'))
      return json({
        due: '2026-10-11',
        nil: false,
        filed: false,
        lateFee: {
          days: 27,
          perDayPaise: 5000,
          capPaise: 1_000_000,
          feePaise: 135_000,
          capped: false,
          version: 'late-fee-v1 (unreviewed)',
        },
      });
    if (path === '/v1/me/filing-board')
      return json({
        today: '2026-11-07',
        periods: ['082026', '092026', '102026'],
        rows: [
          {
            orgId: 'org-1',
            orgName: 'Asha Traders',
            businessId: 'b1',
            businessName: 'Asha Stores',
            gstin: '27AABCD1234E1Z8',
            cells: ['082026', '092026', '102026'].flatMap((fp, i) =>
              (['gstr1', 'gstr3b'] as const).map((ret) => ({
                fp,
                ret,
                status: i === 0 ? 'filed' : i === 1 && ret === 'gstr1' ? 'late' : 'open',
                due: '2026-10-11',
                overdueDays: i === 1 && ret === 'gstr1' ? 27 : 0,
                lateFeePaise: i === 1 && ret === 'gstr1' ? 135_000 : 0,
              })),
            ),
            exceptions: [
              { kind: 'overdue', message: '1 return overdue, the oldest by 27 days', amount: 27 },
            ],
          },
          {
            orgId: 'org-2',
            orgName: 'Mehta Wholesale',
            businessId: 'b2',
            businessName: 'Mehta Wholesale',
            gstin: '29AAACB1234F1Z5',
            cells: [],
            exceptions: [
              {
                kind: 'itc',
                message: 'Rs 42,000 of input credit not reconciled for 092026',
                amount: 4_200_000,
              },
            ],
          },
        ],
      });
    return json({});
  });
  return fake;
}

test.describe('the Filing Desk and the GST portal', () => {
  test('sign in with an OTP, save GSTR-1, pull 2B, and pick up the ARN', async ({ page }) => {
    const fake = await fakeApi(page);
    await openSeeded(page, '/books/gst');
    await expect(page.getByTestId('portal-practice')).toBeVisible();
    await page.getByTestId('portal-user').fill('asha.api');
    await page.getByTestId('portal-send-otp').click();
    await page.getByTestId('portal-otp').fill('000000');
    await page.getByTestId('portal-verify').click();
    await expect(page.getByTestId('portal-connected')).toHaveCount(0); // a wrong OTP does not sign in
    await page.getByTestId('portal-otp').fill('123456');
    await page.getByTestId('portal-verify').click();
    await expect(page.getByTestId('portal-connected')).toBeVisible();
    // the OTP went to the API, not into storage on this device
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('123456');

    await page
      .getByRole('button', { name: /Review/ })
      .first()
      .click();
    await page.getByTestId('tab-portal').click();
    await expect(page.getByTestId('latefee-gstr1')).toContainText('₹1,350.00');
    await expect(page.getByTestId('latefee-gstr1')).toContainText('27 days');
    await page.getByTestId('portal-push').click();
    await expect(page.getByTestId('portal-job-status').first()).toContainText(
      'Portal is processing',
    );
    await expect(page.getByTestId('portal-job-status').first()).toContainText('Done', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('portal-table').first()).toContainText('b2b: 4');
    await expect(page.getByTestId('portal-steps')).toContainText('never files for you');

    await page.getByTestId('portal-pull-2b').click();
    await expect(page.getByTestId('portal-recon')).toContainText('12 imported');
    await page.getByTestId('portal-check').click();
    await expect(page.getByTestId('portal-arn')).toContainText('AA2710260001A1Z');
    expect(
      fake.calls.find(
        (c) => c.path.endsWith('/filing/jobs') && (c.body as { kind?: string })?.kind === 'push',
      )?.body,
    ).toMatchObject({ form: 'gstr1' });
  });
});

test.describe('the CA board', () => {
  test('shows each client, a cell per return and period, and what needs a look', async ({
    page,
  }) => {
    await fakeApi(page);
    await openSeeded(page, '/books/caboard');
    await expect(page.getByTestId('board-row')).toHaveCount(2);
    const late = page.locator('[data-testid="board-cell"][data-status="late"]');
    await expect(late).toHaveCount(1);
    await expect(late).toHaveAttribute('data-period', '092026');
    await expect(page.locator('[data-testid="board-cell"][data-status="filed"]')).toHaveCount(2);
    await expect(page.getByTestId('board-exception')).toHaveCount(2);
    // the biggest first
    await expect(page.getByTestId('board-exception').first()).toContainText('Mehta Wholesale');
    await expect(page.getByTestId('board-exceptions')).toContainText('not reconciled');
  });

  test('without a cloud account it says so', async ({ page }) => {
    await openSeeded(page, '/books/caboard');
    await expect(page.getByTestId('board-signed-out')).toBeVisible();
  });
});

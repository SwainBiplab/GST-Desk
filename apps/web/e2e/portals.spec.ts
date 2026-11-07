import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures';
import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

/**
 * Prompt 47. The Settings tab that shares a business with an accountant and turns the customer pages on, the
 * accountant's Clients page, the customer link from an invoice, and the customer's public page talk to the cloud
 * API; a small fake answers in the browser. The API itself (the share's row-level security and permission
 * narrowing, the token space, revoke and expiry, the export pack, pay through the gateway) is tested against
 * Postgres and MinIO in `apps/api/test/portals.test.ts`.
 */
const API = 'http://localhost:9999';
const TOKEN = 'Qx7JpZt3n9Vb2cL8mK4sAw';

interface Fake {
  calls: { method: string; path: string; body: unknown }[];
  shares: Record<string, unknown>[];
  settings: { enabled: boolean; linkDays: number; statements: boolean; questions: boolean };
  links: Record<string, unknown>[];
  invites: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  packs: Record<string, unknown>[];
  paid: boolean;
  questions: unknown[];
}

const invoice = (paid: boolean) => ({
  kind: 'document',
  business: {
    name: 'Asha Traders',
    gstin: '27AABCD1234E1Z8',
    address: ['12 MG Road', 'Pune', '411001'],
    phone: '9876543210',
    email: null,
  },
  document: {
    type: 'tax_invoice',
    number: 'INV-0042',
    date: '2026-10-15',
    dueDate: '2026-11-14',
    partyName: 'Buyer & Co',
    placeOfSupply: '27',
    status: 'issued',
    lines: [
      {
        description: 'Steel bolts',
        hsn: '7318',
        qty: '100',
        unit: 'NOS',
        ratePaise: 1000,
        taxablePaise: 100_000,
        gstRateBp: 1800,
        totalPaise: 118_000,
      },
    ],
    taxablePaise: 100_000,
    taxPaise: 18_000,
    roundOffPaise: 0,
    totalPaise: 118_000,
    paidPaise: paid ? 118_000 : 0,
    balancePaise: paid ? 0 : 118_000,
    payStatus: paid ? 'paid' : 'unpaid',
    notes: null,
    terms: 'Due in 30 days',
  },
  pay: { available: !paid, url: null },
  questions: true,
  expiresAt: Date.now() + 30 * 86_400_000,
});

async function fakeApi(page: Page, who: 'owner' | 'ca' | 'customer' = 'owner'): Promise<Fake> {
  const fake: Fake = {
    calls: [],
    shares: [],
    settings: { enabled: false, linkDays: 90, statements: true, questions: true },
    links: [],
    invites: [],
    comments: [],
    packs: [],
    paid: false,
    questions: [],
  };
  if (who !== 'customer')
    await page.addInitScript(
      ({ api, email }) => {
        localStorage.setItem(
          'cloud.session',
          JSON.stringify({ baseUrl: api, token: 't', email, signedInAt: 1 }),
        );
      },
      { api: API, email: who === 'ca' ? 'ca@example.com' : 'asha@example.com' },
    );
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

    // the owner's shares and portal settings
    if (path.endsWith('/shares') && req.method() === 'GET') return json(fake.shares);
    if (path.endsWith('/shares') && req.method() === 'POST') {
      const s = {
        id: `share-${fake.shares.length + 1}`,
        businessId: body?.['businessId'],
        email: body?.['email'],
        status: 'pending',
        from: '2026-04-01',
        to: '2027-03-31',
        perms: body?.['perms'],
        expiresAt: null,
        note: body?.['note'] ?? null,
        createdAt: Date.now(),
        acceptedAt: null,
        revokedAt: null,
      };
      fake.shares.unshift(s);
      return json(s, 201);
    }
    if (/\/shares\/[^/]+$/.test(path) && req.method() === 'DELETE') {
      const s = fake.shares.find((x) => path.endsWith(`/${x['id']}`));
      if (s) s['status'] = 'revoked';
      return json(s ?? {});
    }
    if (path.endsWith('/portal/settings') && req.method() === 'GET') return json(fake.settings);
    if (path.endsWith('/portal/settings') && req.method() === 'PUT') {
      const patch = { ...(body ?? {}) } as Record<string, unknown>;
      delete patch['businessId'];
      fake.settings = { ...fake.settings, ...(patch as Partial<Fake['settings']>) };
      return json(fake.settings);
    }
    if (path.endsWith('/portal/links') && req.method() === 'GET') return json(fake.links);
    if (path.endsWith('/portal/links') && req.method() === 'POST') {
      if (!fake.settings.enabled)
        return json(
          { error: { code: 'portal_disabled', message: 'Customer pages are off.' } },
          410,
        );
      const l = {
        id: `link-${fake.links.length + 1}`,
        kind: body?.['documentId'] ? 'document' : 'statement',
        documentId: body?.['documentId'] ?? null,
        partyId: body?.['partyId'] ?? null,
        url: `http://localhost:1420/p/${TOKEN}`,
        expiresAt: Date.now() + Number(body?.['days'] ?? 90) * 86_400_000,
        status: 'live',
        views: 0,
        lastViewedAt: null,
        createdAt: Date.now(),
      };
      fake.links.unshift(l);
      return json(l, 201);
    }
    if (/\/portal\/links\/[^/]+$/.test(path) && req.method() === 'DELETE') {
      const l = fake.links.find((x) => path.endsWith(`/${x['id']}`));
      if (l) l['status'] = 'revoked';
      return json(l ?? {});
    }

    // the accountant
    if (path === '/v1/me/share-invites') return json(fake.invites);
    if (/^\/v1\/share-invites\/[^/]+\/accept$/.test(path)) {
      fake.invites = [];
      return json({ orgId: 'org-1', businessId: 'b1' });
    }
    if (path === '/v1/me/clients')
      return json(
        fake.invites.length
          ? []
          : [
              {
                orgId: 'org-1',
                orgName: 'Asha Traders',
                businessId: 'b1',
                businessName: 'Asha Stores',
                gstin: '27AABCD1234E1Z8',
                cells: [
                  {
                    fp: '092026',
                    ret: 'gstr1',
                    status: 'late',
                    due: '2026-10-11',
                    overdueDays: 27,
                    lateFeePaise: 135_000,
                  },
                  {
                    fp: '092026',
                    ret: 'gstr3b',
                    status: 'open',
                    due: '2026-10-20',
                    overdueDays: 0,
                    lateFeePaise: 0,
                  },
                ],
                exceptions: [
                  {
                    kind: 'overdue',
                    message: '1 return overdue, the oldest by 27 days',
                    amount: 27,
                  },
                ],
                via: 'share',
                share: {
                  id: 'share-1',
                  from: '2026-04-01',
                  to: '2027-03-31',
                  perms: { read: true, gst: true, export: true, comment: true },
                },
                stateCode: '27',
                waiting: 3,
                lastSyncAt: Date.now() - 3_600_000,
                documents: 2,
              },
            ],
      );
    if (path.endsWith('/client/overview'))
      return json({
        business: {
          id: 'b1',
          name: 'Asha Stores',
          legalName: 'Asha Traders',
          gstin: '27AABCD1234E1Z8',
          stateCode: '27',
          scheme: 'regular',
          fyStartMonth: 4,
        },
        access: {
          via: 'share',
          from: '2026-04-01',
          to: '2027-03-31',
          perms: { read: true, gst: true, export: true, comment: true },
        },
        cells: [
          {
            fp: '092026',
            ret: 'gstr1',
            status: 'late',
            due: '2026-10-11',
            overdueDays: 27,
            lateFeePaise: 135_000,
          },
          {
            fp: '092026',
            ret: 'gstr3b',
            status: 'open',
            due: '2026-10-20',
            overdueDays: 0,
            lateFeePaise: 0,
          },
        ],
        exceptions: [
          { kind: 'overdue', message: '1 return overdue, the oldest by 27 days', amount: 27 },
        ],
        counts: { sales: 2, purchases: 0, notes: 0, all: 2 },
      });
    if (path.endsWith('/client/documents'))
      return json({
        rows: [
          {
            id: 'd1',
            type: 'tax_invoice',
            number: 'INV-0042',
            date: '2026-10-15',
            partyName: 'Buyer & Co',
            status: 'issued',
            totalPaise: 118_000,
            irn: false,
          },
          {
            id: 'd2',
            type: 'tax_invoice',
            number: 'INV-0041',
            date: '2026-05-10',
            partyName: 'Buyer & Co',
            status: 'issued',
            totalPaise: 59_000,
            irn: false,
          },
        ],
        count: 2,
      });
    if (/\/client\/documents\/[^/]+\/pdf$/.test(path))
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 fake' });
    if (path.endsWith('/client/comments') && req.method() === 'GET') return json(fake.comments);
    if (path.endsWith('/client/comments') && req.method() === 'POST') {
      const c = {
        id: `c-${fake.comments.length + 1}`,
        documentId: body?.['documentId'] ?? null,
        number: body?.['documentId'] ? 'INV-0042' : null,
        text: body?.['text'],
        by: 'u2',
        byName: 'Meera CA',
        status: 'pending',
        createdAt: Date.now(),
      };
      fake.comments.unshift(c);
      return json(c, 201);
    }
    if (path.endsWith('/client/export-packs') && req.method() === 'GET') {
      for (const p of fake.packs) if (p['status'] === 'running') p['status'] = 'done';
      return json(fake.packs);
    }
    if (path.endsWith('/client/export-packs') && req.method() === 'POST') {
      const p = {
        id: `pack-${fake.packs.length + 1}`,
        businessId: 'b1',
        from: body?.['from'],
        to: body?.['to'],
        status: 'running',
        sizeBytes: 2_621_440,
        manifest: { files: [], counts: { pdfs: 2 }, warnings: ['tally: a party has no state'] },
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
      };
      fake.packs.unshift(p);
      return json(p, 202);
    }
    if (/\/client\/export-packs\/[^/]+\/download$/.test(path))
      return json({ url: `${API}/download/pack.zip`, expiresAt: Date.now() + 600_000 });

    // the customer
    if (path === `/v1/p/${TOKEN}`) return json(invoice(fake.paid));
    if (path === `/v1/p/${TOKEN}/pdf`)
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: { 'content-disposition': 'attachment; filename="INV-0042.pdf"' },
        body: '%PDF-1.4 fake',
      });
    if (path === `/v1/p/${TOKEN}/pay`)
      return json({ url: `${API}/paid`, amountPaise: 118_000, expiresAt: Date.now() + 86_400_000 });
    if (path === `/v1/p/${TOKEN}/question`) {
      fake.questions.push(body);
      return json({ ok: true }, 201);
    }
    if (path.startsWith('/v1/p/'))
      return json(
        { error: { code: 'portal_not_found', message: 'That link was not found.' } },
        404,
      );
    if (path === '/paid') {
      fake.paid = true;
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<h1 data-testid="gateway-paid">Paid at the gateway</h1>',
      });
    }
    return json({});
  });
  return fake;
}

test.describe('sharing with an accountant and the customer pages', () => {
  test('the owner shares the business for a year, turns the customer pages on, and makes a customer link', async ({
    page,
  }) => {
    const fake = await fakeApi(page);
    await openSeeded(page, '/books/settings?tab=sharing');
    await expect(page.getByTestId('share-card')).toBeVisible();
    await expect(page.getByTestId('shares-none')).toBeVisible();
    await page.getByTestId('share-email').fill('ca@example.com');
    await page.getByTestId('share-fy').fill('2026-27');
    await page.getByTestId('share-perm-export').click(); // off
    await page.getByTestId('share-submit').click();
    await expect(page.getByTestId('share-row')).toHaveCount(1);
    await expect(page.getByTestId('share-row')).toContainText('ca@example.com');
    await expect(page.getByTestId('share-row')).toContainText('Waiting to accept');
    const made = fake.calls.find((c) => c.path.endsWith('/shares') && c.method === 'POST')!
      .body as Record<string, unknown>;
    expect(made).toMatchObject({ email: 'ca@example.com', fy: '2026-27' });
    expect(made['perms']).toMatchObject({ read: true, gst: true, export: false, comment: true });

    // the customer pages start off; a link cannot be made until they are on
    await openSeeded(page, '/books/documents');
    await page.getByTestId('doc-filter-status').click();
    await page.getByRole('option', { name: 'Issued', exact: true }).first().click();
    await page.getByTestId('document-open').first().click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-customer-link').click();
    await expect(page.getByTestId('customer-link-off')).toBeVisible();
    await page.keyboard.press('Escape');

    await openSeeded(page, '/books/settings?tab=sharing');
    await page.getByTestId('portal-enabled').click();
    await expect(page.getByTestId('portal-enabled')).toHaveAttribute('data-state', 'checked');
    expect(fake.settings.enabled).toBe(true);

    await openSeeded(page, '/books/documents');
    await page.getByTestId('doc-filter-status').click();
    await page.getByRole('option', { name: 'Issued', exact: true }).first().click();
    await page.getByTestId('document-open').first().click();
    await page.getByTestId('doc-more').click();
    await page.getByTestId('doc-customer-link').click();
    await page.getByTestId('customer-link-days').fill('30');
    await page.getByTestId('customer-link-make').click();
    await expect(page.getByTestId('customer-link-url')).toContainText(`/p/${TOKEN}`);
    await expect(page.getByTestId('customer-link-row')).toHaveCount(1);
    await page.getByTestId('customer-link-revoke').click();
    await expect(page.getByTestId('customer-link-row')).toHaveCount(0);
    // the share's revoke
    await openSeeded(page, '/books/settings?tab=sharing');
    await page.getByTestId('share-revoke').click();
    await expect(page.getByTestId('share-row')).toContainText('Revoked');
  });

  test('the accountant accepts the share, reads the client, comments and takes an export pack', async ({
    page,
  }) => {
    const fake = await fakeApi(page, 'ca');
    fake.invites = [
      {
        id: 'share-1',
        orgName: 'Asha Traders',
        businessName: 'Asha Stores',
        gstin: '27AABCD1234E1Z8',
        from: '2026-04-01',
        to: '2027-03-31',
        perms: { read: true, gst: true, export: true, comment: true },
        note: 'FY 26-27 books',
        createdAt: Date.now(),
      },
    ];
    await openSeeded(page, '/books/clients');
    await expect(page.getByTestId('share-invite')).toContainText('Asha Stores');
    await page.getByTestId('share-accept').click();
    await expect(page.getByTestId('client-row')).toHaveCount(1);
    await expect(page.getByTestId('client-row')).toContainText('1 return late');
    await expect(page.getByTestId('client-row')).toContainText('3 items waiting');
    await page.getByTestId('client-open').click();
    await expect(page.getByTestId('client-access')).toContainText('Read-only');
    await expect(page.getByTestId('client-count-sales')).toHaveText('2');
    await expect(page.getByTestId('client-cell').first()).toHaveAttribute('data-status', 'late');
    await expect(page.getByTestId('client-exception')).toContainText('27 days');

    await page.getByTestId('client-tab-documents').click();
    await expect(page.getByTestId('client-doc-row')).toHaveCount(2);
    await expect(page.getByTestId('client-doc-count')).toContainText('2 documents');
    const download = page.waitForEvent('download');
    await page.getByTestId('client-doc-pdf').first().click();
    expect((await download).suggestedFilename()).toContain('INV-0042');
    await page.getByTestId('client-doc-comment').first().click();
    await page.getByTestId('client-comment-text').fill('HSN on line 1 looks wrong');
    await page.getByTestId('client-comment-send').click();
    await expect(page.getByTestId('client-comment-dialog')).toHaveCount(0);
    expect(
      fake.calls.find((c) => c.path.endsWith('/client/comments') && c.method === 'POST')?.body,
    ).toMatchObject({ documentId: 'd1', text: 'HSN on line 1 looks wrong' });
    await page.getByTestId('client-tab-comments').click();
    await expect(page.getByTestId('client-comment')).toContainText('Meera CA');
    await expect(page.getByTestId('client-comment')).toContainText('INV-0042');

    await page.getByTestId('client-tab-exports').click();
    await expect(page.getByTestId('pack-from')).toHaveValue('2026-04-01');
    await page.getByTestId('pack-to').fill('2026-10-31');
    await page.getByTestId('pack-build').click();
    await expect(page.getByTestId('pack-row')).toHaveAttribute('data-status', 'done', {
      timeout: 10_000,
    });
    await expect(page.getByTestId('pack-row')).toContainText('2.5 MB');
    await expect(page.getByTestId('pack-row')).toContainText('1 note');
    // the signed address opens in a new tab (its bytes are the store's, outside the fake)
    const popup = page.waitForEvent('popup');
    await page.getByTestId('pack-download').click();
    await popup;
    expect(fake.calls.some((c) => /\/client\/export-packs\/pack-1\/download$/.test(c.path))).toBe(
      true,
    );
    expect(
      fake.calls.find((c) => c.path.endsWith('/client/export-packs') && c.method === 'POST')?.body,
    ).toMatchObject({ from: '2026-04-01', to: '2026-10-31' });
  });

  test('the customer opens the link, sees the invoice, pays, downloads the PDF and asks a question', async ({
    page,
  }) => {
    const fake = await fakeApi(page, 'customer');
    await page.goto(`/p/${TOKEN}?api=${encodeURIComponent(API)}`);
    await expect(page.getByTestId('portal-business')).toContainText('Asha Traders');
    await expect(page.getByTestId('portal-document')).toContainText('INV-0042');
    await expect(page.getByTestId('portal-line')).toHaveCount(1);
    await expect(page.getByTestId('portal-total')).toHaveText('₹1,180.00');
    await expect(page.getByTestId('portal-balance')).toHaveText('₹1,180.00');
    await expect(page.getByTestId('portal-pay-status')).toHaveAttribute('data-status', 'unpaid');
    // no shell, no sign-in, no local book around the page
    await expect(page.getByTestId('badge-documents')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(0);

    const download = page.waitForEvent('download');
    await page.getByTestId('portal-pdf').click();
    expect((await download).suggestedFilename()).toBe('INV-0042.pdf');

    await page.getByTestId('portal-question-name').fill('Ravi');
    await page.getByTestId('portal-question-text').fill('Please send the e-way bill too');
    await page.getByTestId('portal-question-send').click();
    await expect(page.getByTestId('portal-question-sent')).toBeVisible();
    expect(fake.questions[0]).toMatchObject({
      name: 'Ravi',
      text: 'Please send the e-way bill too',
    });

    await page.getByTestId('portal-pay').click();
    await expect(page.getByTestId('gateway-paid')).toBeVisible();
    // back on the page after paying, it says so
    await page.goto(`/p/${TOKEN}?api=${encodeURIComponent(API)}`);
    await expect(page.getByTestId('portal-pay-status')).toHaveAttribute('data-status', 'paid');
    await expect(page.getByTestId('portal-pay')).toHaveCount(0);

    // a made-up token is "not found", and says nothing else
    await page.goto(`/p/AAAAAAAAAAAAAAAAAAAAAA?api=${encodeURIComponent(API)}`);
    await expect(page.getByTestId('portal-not-found')).toBeVisible();
  });
});

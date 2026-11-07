import type { Page, Route } from '@playwright/test';

import { expect, test } from './fixtures';
import { openCommandBar, openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

/**
 * Prompt 42. The Team tab and the approval card talk to the cloud API; here a small fake of the API
 * answers in the browser (Playwright routes), so the screens are tested without a server. The API itself
 * is tested against Postgres in `apps/api/test/team.test.ts`. The restricted screens use the demo hook
 * that acts as a member with a role.
 */
const API = 'http://localhost:9999';

interface Fake {
  calls: { method: string; path: string; body: unknown }[];
  invites: { id: string; email: string | null; phone: string | null; role: string }[];
  mine: { id: string; orgId: string; orgName: string; roleName: string; invitedBy: string }[];
}

async function fakeApi(page: Page, role = 'owner'): Promise<Fake> {
  const fake: Fake = {
    calls: [],
    invites: [],
    mine: [
      {
        id: 'inv-for-me',
        orgId: 'org-2',
        orgName: 'Mehta Wholesale',
        roleName: 'accountant',
        invitedBy: 'R. Mehta',
      },
    ],
  };
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
        user: { id: 'u-asha', email: 'asha@example.com', phone: null, name: 'Asha', locale: 'en' },
        organisations: [{ id: 'org-1', name: 'Asha Traders', role }],
        activeOrganizationId: null,
      });
    if (path === '/v1/me/invites') return json(fake.mine);
    if (/^\/v1\/invites\/[^/]+\/accept$/.test(path)) {
      fake.mine = [];
      return json({ orgId: 'org-2' });
    }
    if (/\/permissions$/.test(path))
      return json({
        memberId: 'm-asha',
        permissions: { role, grants: {} },
        policy: { approvals: false },
      });
    if (/\/team$/.test(path))
      return json({
        members: [
          {
            memberId: 'm-asha',
            userId: 'u-asha',
            name: 'Asha',
            email: 'asha@example.com',
            phone: null,
            role: 'owner',
            roleId: null,
            roleName: 'owner',
            createdAt: 1,
            devices: [
              { id: 'd1', name: 'Counter PC', platform: 'windows', lastSeenAt: 1, revokedAt: null },
            ],
          },
          {
            memberId: 'm-bala',
            userId: 'u-bala',
            name: 'Bala',
            email: 'bala@example.com',
            phone: null,
            role: 'sales',
            roleId: null,
            roleName: 'sales',
            createdAt: 2,
            devices: [],
          },
        ],
        invites: fake.invites.map((i) => ({
          ...i,
          roleId: null,
          roleName: i.role,
          status: 'pending',
          expiresAt: Date.now() + 7 * 86_400_000,
          createdAt: Date.now(),
        })),
        roles: [],
        policy: { approvals: false },
      });
    if (/\/invites$/.test(path) && req.method() === 'POST') {
      const b = body as { email?: string; phone?: string; role: string };
      const inv = {
        id: `inv-${fake.invites.length + 1}`,
        email: b.email ?? null,
        phone: b.phone ?? null,
        role: b.role,
      };
      fake.invites.push(inv);
      return json(
        { ...inv, roleId: null, roleName: b.role, status: 'pending', expiresAt: 0, createdAt: 0 },
        201,
      );
    }
    if (/\/approvals\/[^/]+$/.test(path))
      return json({
        outcome: (body as { decision: string }).decision === 'approve' ? 'approved' : 'declined',
      });
    if (/\/devices\/[^/]+\/revoke$/.test(path) || /\/members\//.test(path))
      return route.fulfill({ status: 204, body: '' });
    return json({ error: { code: 'not_found', message: `fake: ${path}` } }, 404);
  });
  return fake;
}

test.describe('team', () => {
  test('an owner sees the team and invites by e-mail, by phone with the accountant preset', async ({
    page,
  }) => {
    const fake = await fakeApi(page);
    await openSeeded(page, '/books/settings?tab=team');
    await expect(page.getByTestId('team-my-role')).toContainText('Owner');
    await expect(page.getByTestId('team-member')).toHaveCount(2);
    await expect(page.getByTestId('team-devices')).toContainText('Counter PC');

    await page.getByTestId('team-invite-to').fill('chitra@example.com');
    await page.getByTestId('team-invite-send').click();
    await expect(page.getByTestId('team-pending')).toContainText('chitra@example.com');
    expect(
      fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/invites'))?.body,
    ).toEqual({ email: 'chitra@example.com', role: 'sales' });

    await page.getByTestId('team-invite-to').fill('+919876543210');
    await page.getByTestId('team-invite-accountant').click();
    await expect(page.getByTestId('team-pending')).toContainText('+919876543210');
    expect(
      fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/invites')).at(-1)?.body,
    ).toEqual({
      phone: '+919876543210',
      role: 'accountant',
    });

    // a custom role cannot hold more than the owner has; the editor shows every module
    await page.getByTestId('team-role-new').click();
    await expect(page.getByTestId('team-role-grid')).toContainText('Sales invoices and receipts');
  });

  test('someone invited sees the invitation and joins', async ({ page }) => {
    const fake = await fakeApi(page, 'viewer');
    await openSeeded(page, '/books/settings?tab=team');
    const mine = page.getByTestId('team-my-invites');
    await expect(mine).toContainText('Mehta Wholesale invites you as accountant');
    await page.getByTestId('team-accept').click();
    await expect(mine).toBeHidden();
    expect(fake.calls.some((c) => c.path === '/v1/invites/inv-for-me/accept')).toBe(true);
    // a viewer sees the team but cannot invite
    await expect(page.getByTestId('team-invite')).toBeHidden();
  });
});

test.describe('what a role sees', () => {
  test('a counter cannot buy, cancel or open reports; a viewer cannot make anything', async ({
    page,
  }) => {
    await openSeeded(page, '/books/documents');
    await page.waitForFunction(() => !!window.__gstSync);
    await page.evaluate(() => window.__gstSync!.setRole('sales'));

    await openCommandBar(page);
    await page.getByTestId('command-input').fill('new');
    await expect(page.getByRole('option', { name: /New invoice/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /New purchase/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Reports' })).toHaveCount(
      0,
    );

    // an issued invoice: no cancel for a counter
    await page.getByTestId('doc-filter-status').click();
    await page.getByRole('option', { name: 'Issued', exact: true }).first().click();
    await page.getByTestId('document-open').first().click();
    await expect(page.getByTestId('doc-editor')).toBeVisible();
    await page.getByTestId('doc-more').click();
    await expect(page.getByTestId('doc-cancel')).toHaveAttribute('data-disabled', '');
    await page.keyboard.press('Escape');

    await page.evaluate(() => window.__gstSync!.setRole('viewer'));
    await expect(page.getByTestId('doc-edit')).toBeDisabled();
    // inside the app, so the role stays
    await page.getByTestId('nav-parties').click();
    await expect(page.getByTestId('party-search')).toBeVisible();
    await expect(page.getByTestId('new-party')).toHaveCount(0);

    // back to the book's owner
    await page.evaluate(() => window.__gstSync!.setRole(null));
    await expect(page.getByTestId('new-party')).toBeVisible();
  });

  test('a cancellation waiting for approval: the clerk waits, an owner approves', async ({
    page,
  }) => {
    const fake = await fakeApi(page);
    await openSeeded(page, '/books/inbox');
    await page.waitForFunction(() => !!window.__gstSync);
    await page.evaluate(() => window.__gstSync!.raiseApproval());
    await page.evaluate(() => window.__gstSync!.setRole('sales', true));
    await page.getByTestId('inbox-kind').click();
    await page.getByRole('option', { name: 'Waiting for approval' }).click();
    const card = page.getByTestId('approval-detail');
    await expect(card).toContainText('waits for an approver');
    await expect(page.getByTestId('approval-waiting')).toBeVisible();
    await expect(page.getByTestId('detail-accept')).toHaveCount(0);

    await page.evaluate(() => window.__gstSync!.setRole('owner', true));
    await page.getByTestId('approval-approve').click();
    await expect(page.getByTestId('approval-done')).toContainText('Approved');
    const call = fake.calls.find((c) => /\/approvals\//.test(c.path));
    expect(call?.body).toEqual({ decision: 'approve' });
  });
});

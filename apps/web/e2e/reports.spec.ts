import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

import { openSeeded } from './helpers';

test.use({ viewport: { width: 1366, height: 900 } });
test.setTimeout(120_000);

/** The whole two-year demo book, whatever today's date is. */
const ALL = 'preset=custom&from=2024-04-01&to=2026-03-31';

const reportUrl = (id: string, extra = '') => `/books/reports?report=${id}&${ALL}${extra}`;

async function openReport(page: Page, id: string, extra = '') {
  await page.goto(reportUrl(id, extra));
  await expect(page.getByTestId('report-view')).toHaveAttribute('data-report', id);
  await expect(page.getByTestId('report-summary')).not.toHaveText(/Loading/, { timeout: 30_000 });
}

const totalOf = async (page: Page, col: string) =>
  (
    (await page.getByTestId('report-totals').locator(`[data-col="${col}"]`).textContent()) ?? ''
  ).trim();

test.describe('reports and dashboards', () => {
  test('every Books dashboard number opens the report it came from, with the same figure', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    for (const key of ['gst', 'cash', 'overdue', 'spend', 'month', 'review']) {
      await expect(page.getByTestId(`card-${key}`)).toBeVisible();
    }
    await expect(page.getByTestId('card-gst')).toContainText('GST this month');

    // to collect: the same figure as the totals row of Party outstanding
    const toCollect = page.getByTestId('dash-receivables-value');
    await expect(toCollect).toContainText('₹');
    const shown = ((await toCollect.textContent()) ?? '').replace('₹', '').trim();
    await page.getByTestId('dash-receivables').click();
    await expect(page.getByTestId('report-view')).toHaveAttribute(
      'data-report',
      'party_outstanding',
    );
    await expect(page).toHaveURL(/report=party_outstanding/);
    await expect(page).toHaveURL(/side=receivable/);
    await expect(page.getByTestId('report-summary')).not.toHaveText(/Loading/, { timeout: 30_000 });
    expect(await totalOf(page, 'outstanding')).toBe(shown);

    // to pay opens the payable side
    await page.goBack();
    await expect(page.getByTestId('dashboard-frame')).toBeVisible();
    await page.getByTestId('dash-payables').click();
    await expect(page).toHaveURL(/side=payable/);
    await expect(page.getByTestId('report-side')).toContainText('To pay');

    // GST estimate opens the GST summary for this month
    await page.goBack();
    await page.getByTestId('dash-gst').click();
    await expect(page.getByTestId('report-view')).toHaveAttribute('data-report', 'gst_summary');
    await expect(page.getByTestId('report-preset')).toContainText('This month');

    // the month card opens the sales register for this month
    await page.goBack();
    await page.getByTestId('dash-month').click();
    await expect(page.getByTestId('report-view')).toHaveAttribute('data-report', 'sales_register');
    await expect(page).toHaveURL(/preset=this_month/);
  });

  test('the overdue card lists late customers and opens the party', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    await expect(page.getByTestId('dash-overdue-list')).toBeVisible();
    const rows = page.getByTestId('dash-overdue-row');
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThanOrEqual(5);
    await rows.first().click();
    await expect(page).toHaveURL(/\/books\/parties\?open=/);
  });

  test('the Shop dashboard answers its four questions', async ({ page }) => {
    await openSeeded(page, '/shop/dashboard');
    for (const key of ['sold', 'owed', 'low', 'attention']) {
      await expect(page.getByTestId(`card-${key}`)).toBeVisible();
    }
    await expect(page.getByTestId('card-sold')).toContainText('sell today');
    // stock tracking is off for the demo shop preset or on; either way the card says something
    await expect(page.getByTestId('card-low')).not.toContainText('Working it out');
    await expect(page.getByTestId('dash-receivables-value')).toContainText('₹');
    await page.getByTestId('dash-sales-today').click();
    await expect(page.getByTestId('report-view')).toHaveAttribute('data-report', 'sales_register');
    await expect(page).toHaveURL(/\/shop\/reports\?.*preset=today/);
  });

  test('the Books dashboard charts show the same figures as the reports they open', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    for (const id of ['chart-trend', 'chart-cash', 'chart-customers']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    // the demo book ends in March 2026, so the charts run to its latest sale and say so
    await expect(page.getByTestId('chart-trend')).toContainText('runs to');
    const legend = page.getByTestId('chart-trend').getByTestId('chart-legend');
    await expect(legend).toContainText('Sales');
    await expect(legend).toContainText('Spend');
    await expect(page.getByTestId('chart-cash').getByTestId('chart-legend')).toContainText(
      'Money in',
    );
    expect(await page.getByTestId('chart-trend').getByTestId('bar-sales').count()).toBeGreaterThan(
      3,
    );
    await expect(page.getByTestId('chart-cash').getByTestId('line-receipts')).toBeVisible();

    // hovering the last month's sales bar names the month and the amount
    const bar = page.getByTestId('chart-trend').getByTestId('bar-sales').last();
    await bar.hover();
    const tip = page.getByTestId('chart-tooltip');
    await expect(tip).toBeVisible();
    const month = ((await tip.locator('p').first().textContent()) ?? '').trim();
    expect(month).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
    const shown = ((await tip.getByText('₹').first().textContent()) ?? '').replace('₹', '').trim();

    // clicking it opens the sales register for that month, whose total is the bar
    await bar.click();
    await expect(page.getByTestId('report-view')).toHaveAttribute('data-report', 'sales_register');
    await expect(page).toHaveURL(/preset=custom/);
    await expect(page.getByTestId('report-summary')).not.toHaveText(/Loading/, { timeout: 30_000 });
    expect(await totalOf(page, 'total')).toBe(shown);
  });

  test('a chart can be read as a table, and the top customers open their party', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await page.getByTestId('chart-trend-switch').click();
    const table = page.getByTestId('chart-trend').getByTestId('chart-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(6);
    await page.getByTestId('chart-trend-switch').click();
    await expect(page.getByTestId('chart-columns').first()).toBeVisible();

    const rows = page.getByTestId('chart-customers').getByTestId('chart-bar-row');
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThanOrEqual(5);
    await rows.first().click();
    await expect(page).toHaveURL(/\/books\/parties\?open=/);
  });

  test('the Shop dashboard charts the last 14 days and the best customers, in dark mode too', async ({
    page,
  }) => {
    await openSeeded(page, '/shop/dashboard');
    await expect(page.getByTestId('chart-days')).toBeVisible();
    await expect(page.getByTestId('chart-customers')).toBeVisible();
    expect(await page.getByTestId('chart-days').getByTestId('bar-sales').count()).toBeGreaterThan(
      0,
    );
    // one series: the title names it, so there is no legend box
    await expect(page.getByTestId('chart-days').getByTestId('chart-legend')).toHaveCount(0);

    const fill = (await page
      .getByTestId('chart-days')
      .getByTestId('bar-sales')
      .first()
      .getAttribute('fill'))!;
    expect(fill).toBe('var(--viz-1)');
    const light = await page
      .getByTestId('chart-days')
      .locator('.viz')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--viz-1').trim());
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const dark = await page
      .getByTestId('chart-days')
      .locator('.viz')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--viz-1').trim());
    expect(light).toBe('#2a78d6');
    expect(dark).toBe('#3987e5');
  });

  test('the report list opens each report', async ({ page }) => {
    await openSeeded(page, '/books/reports');
    await expect(page.getByTestId('reports-list')).toBeVisible();
    for (const id of [
      'sales_register',
      'purchase_register',
      'note_register',
      'party_outstanding',
      'receivables_payables',
      'gst_summary',
      'hsn_summary',
      'document_summary',
      'expense_summary',
      'receipts_payments',
      'day_book',
      'party_sales',
      'item_sales',
    ]) {
      await expect(page.getByTestId(`report-link-${id}`)).toBeVisible();
    }
    await page.getByTestId('report-link-hsn_summary').click();
    await expect(page.getByTestId('report-view')).toHaveAttribute('data-report', 'hsn_summary');
    await page.getByTestId('reports-back').click();
    await expect(page.getByTestId('reports-list')).toBeVisible();
  });

  test('sales register, GST summary and HSN summary agree on the taxable total', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await openReport(page, 'sales_register');
    await expect(page.getByTestId('report-row').first()).toBeVisible();
    const taxable = await totalOf(page, 'taxable');
    expect(taxable).toMatch(/^\d[\d,]*\.\d{2}$/);

    await openReport(page, 'gst_summary');
    expect(await totalOf(page, 'taxable')).toBe(taxable);

    await openReport(page, 'hsn_summary');
    expect(await totalOf(page, 'taxable')).toBe(taxable);

    // a register is paged: scroll to load more than the first page
    await openReport(page, 'sales_register');
    const summary = (await page.getByTestId('report-summary').textContent()) ?? '';
    const count = Number(/^([\d,]+) rows/.exec(summary)![1]!.replace(/,/g, ''));
    expect(count).toBeGreaterThan(200);
    await expect(page.getByTestId('report-summary')).toContainText('showing 200');
    await page.getByTestId('report-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(page.getByTestId('report-summary')).not.toContainText('showing 200', {
      timeout: 20_000,
    });
  });

  test('credit notes show as minus in the sales register and the period filter narrows it', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await openReport(page, 'sales_register', '&type=credit_note');
    const first = page.getByTestId('report-row').first();
    await expect(first).toBeVisible();
    await expect(first.locator('[data-col="total"]')).toContainText('-');
    await expect(first.locator('[data-col="type"]')).toContainText('Credit note');

    await openReport(page, 'sales_register');
    const all = (await page.getByTestId('report-summary').textContent()) ?? '';
    await page.getByTestId('report-to').fill('2024-06-30');
    await expect(page).toHaveURL(/to=2024-06-30/);
    await expect(page.getByTestId('report-summary')).not.toHaveText(all);
    const narrowed = (await page.getByTestId('report-summary').textContent()) ?? '';
    expect(Number(/^([\d,]+) rows/.exec(narrowed)![1]!.replace(/,/g, ''))).toBeLessThan(
      Number(/^([\d,]+) rows/.exec(all)![1]!.replace(/,/g, '')),
    );
  });

  test('grouping gathers rows under headings with subtotals, and the column chooser changes the columns', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await openReport(page, 'gst_summary');
    await page.getByTestId('report-group').click();
    await page.getByRole('option', { name: /Group by Supply/ }).click();
    await expect(page).toHaveURL(/group=supply/);
    await expect(page.getByTestId('report-group-row').first()).toBeVisible();
    expect(await page.getByTestId('report-subtotal').count()).toBe(
      await page.getByTestId('report-group-row').count(),
    );

    await openReport(page, 'sales_register');
    await expect(page.getByRole('columnheader', { name: 'GSTIN' })).toHaveCount(0);
    await page.getByTestId('report-columns').click();
    await page.getByTestId('report-col-gstin').click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/cols=/);
    await expect(page.getByRole('columnheader', { name: 'GSTIN' })).toBeVisible();
    await expect(
      page.getByTestId('report-row').first().locator('[data-col="gstin"]'),
    ).toBeAttached();
  });

  test('a saved view brings back the period, filters, grouping and columns', async ({ page }) => {
    await openSeeded(page, '/books/dashboard');
    await openReport(page, 'sales_register', '&group=party&cols=date,number,party,total');
    await page.getByTestId('report-save-view').click();
    await page.getByTestId('report-view-name').fill('Party-wise, my columns');
    await page.getByTestId('report-view-save').click();
    await expect(page.getByText('Saved “Party-wise, my columns”.')).toBeVisible();

    // somewhere else entirely
    await openReport(page, 'gst_summary');
    await page.getByTestId('report-views').click();
    await page
      .getByTestId('report-saved-view')
      .filter({ hasText: 'Party-wise, my columns' })
      .click();
    await expect(page.getByTestId('report-view')).toHaveAttribute('data-report', 'sales_register');
    await expect(page).toHaveURL(/group=party/);
    await expect(page).toHaveURL(/cols=date(%2C|,)number(%2C|,)party(%2C|,)total/);
    await expect(page.getByTestId('report-group-row').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('columnheader')).toHaveCount(4);

    // and it is still there after a reload (kept with the business, not the tab)
    await page.reload();
    await page.getByTestId('report-views').click();
    await expect(
      page.getByTestId('report-saved-view').filter({ hasText: 'Party-wise, my columns' }),
    ).toBeVisible();
    // delete it
    await page.getByRole('button', { name: 'Delete the view Party-wise, my columns' }).click();
    await page.keyboard.press('Escape');
    await page.getByTestId('report-views').click();
    await expect(page.getByText('No saved views yet.')).toBeVisible();
  });

  test('exports CSV and Excel with every row, amounts as numbers, and the totals row', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await openReport(page, 'sales_register');
    const summary = (await page.getByTestId('report-summary').textContent()) ?? '';
    const count = Number(/^([\d,]+) rows/.exec(summary)![1]!.replace(/,/g, ''));

    const csvDownload = page.waitForEvent('download');
    await page.getByTestId('report-export-csv').click();
    const csvFile = await csvDownload;
    expect(csvFile.suggestedFilename()).toMatch(/Sales_register_2024-04-01_2026-03-31\.csv$/);
    const csv = readFileSync((await csvFile.path())!, 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trimEnd().split(/\r\n/);
    expect(lines).toHaveLength(count + 2); // header, every row, totals
    expect(lines[0]).toBe(
      'Date,Number,Type,Party,Taxable value,CGST,SGST / UTGST,IGST,Invoice value',
    );
    expect(lines.at(-1)).toMatch(/^Total,/);
    // amounts are plain decimals in rupees, never grouped or with a symbol
    expect(lines[1]).toMatch(/,-?\d+\.\d{2},-?\d+\.\d{2},-?\d+\.\d{2},-?\d+\.\d{2},-?\d+\.\d{2}$/);

    const xlsxDownload = page.waitForEvent('download');
    await page.getByTestId('report-export-xlsx').click();
    const xlsxFile = await xlsxDownload;
    expect(xlsxFile.suggestedFilename()).toMatch(/\.xlsx$/);
    const bytes = readFileSync((await xlsxFile.path())!);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    const sheet = strFromU8(unzipSync(new Uint8Array(bytes))['xl/worksheets/sheet1.xml']!);
    expect((sheet.match(/<row /g) ?? []).length).toBe(count + 2);
    expect(sheet).not.toContain('<f>');
    // the date column holds real dates and the amounts real numbers, not text
    expect(sheet).toMatch(/<c r="A2" s="7"><v>\d{5}<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="E2" s="[26]"><v>-?\d+(\.\d+)?<\/v><\/c>/);
  });

  test('a row opens its document, and printing lays out the report on its own sheet', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await openReport(page, 'sales_register', '&type=tax_invoice');
    await page.evaluate(() => {
      (window as unknown as { printed: number }).printed = 0;
      window.print = () => {
        const w = window as unknown as { printed: number; sheetRows: number };
        w.printed += 1;
        w.sheetRows = document.querySelectorAll(
          '[data-testid="report-print-sheet"] tbody tr',
        ).length;
      };
    });
    await page.getByTestId('report-print').click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed))
      .toBe(1);
    // the sheet carries the rows (up to the cap) and the business name
    expect(
      await page.evaluate(() => (window as unknown as { sheetRows: number }).sheetRows),
    ).toBeGreaterThan(200);

    await page.getByTestId('report-row').first().click();
    await expect(page).toHaveURL(/\/books\/documents\/.*id=/);
  });

  test('party outstanding, ageing and receipts books load, and a party row opens Party 360', async ({
    page,
  }) => {
    await openSeeded(page, '/books/dashboard');
    await openReport(page, 'party_outstanding', '&side=all');
    await expect(page.getByTestId('report-row').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: '90+' })).toBeVisible();
    await page.getByTestId('report-row').first().click();
    await expect(page).toHaveURL(/\/books\/parties\?open=/);

    await openReport(page, 'receipts_payments', '&book=cash');
    const rows = await page
      .getByTestId('report-row')
      .locator('[data-col="mode"]')
      .allTextContents();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m) => m.trim() === 'Cash')).toBe(true);

    await openReport(page, 'document_summary');
    await expect(
      page.getByTestId('report-row').first().locator('[data-col="from"]'),
    ).not.toBeEmpty();
    await openReport(page, 'receivables_payables', '');
    await expect(page.getByTestId('report-row')).toHaveCount(7);
  });
});

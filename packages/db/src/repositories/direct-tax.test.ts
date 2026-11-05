import {
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { BusinessRepo, PartyRepo, createOrganisation } from './aggregates';
import { RuleError, type Ctx } from './base';
import { DirectTaxRepo } from './direct-tax';
import { DocumentFlowRepo } from './document-flow';

const R = (n: number): bigint => BigInt(Math.round(n * 100));
let k = 0;
const line = (ratePaise: bigint, over: Partial<DraftLine> = {}): DraftLine => ({
  ...emptyDraftLine(`k${++k}`),
  description: 'Service',
  qtyMicros: 1_000_000n,
  ratePaise,
  gstRateBp: 1800,
  ...over,
});

describe.each(DIALECTS)('TDS, TCS, challans and receivables (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let flow: DocumentFlowRepo;
  let repo: DirectTaxRepo;
  let contractor: string;
  let rent: string;
  let scrapBuyer: string;
  let noPan: string;

  const issue = async (
    type: 'purchase_bill' | 'tax_invoice',
    partyId: string,
    date: string,
    rate: bigint,
  ) => {
    const dr: DraftDocument = {
      ...emptyDraft(type, date, { supplierState: '27' }),
      partyId,
      lines: [line(rate)],
    };
    const r = draftToRows(dr);
    const saved = await flow.saveDraft(ctx, {
      doc: r.doc as unknown as Record<string, unknown>,
      lines: r.lines as unknown as Record<string, unknown>[],
    });
    return flow.issueDraft(ctx, saved.document['id'], saved.document['version']);
  };

  beforeAll(async () => {
    d = await openTestDb(dialect);
    const org = await createOrganisation(d, 'Org');
    const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev' };
    const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
    ctx = { ...base, businessId: biz['id'] };
    flow = new DocumentFlowRepo(d);
    repo = new DirectTaxRepo(d);
    const parties = new PartyRepo(d);
    const mk = async (over: Record<string, unknown>) =>
      (await parties.create(ctx, { type: 'both', state_code: '27', ...over } as never))['id'];
    contractor = await mk({
      name: 'Sharma Works',
      pan: 'AAAPS1234C',
      tds_section: '194C',
      tds_category: 'individual_huf',
    });
    rent = await mk({ name: 'Landlord Co', pan: 'AAAPL1234C', tds_section: '194I(b)' });
    scrapBuyer = await mk({ name: 'Scrap Buyer', pan: 'AAAPB1234C', tcs_nature: 'scrap' });
    noPan = await mk({ name: 'No PAN Contractor', tds_section: '194C', tds_category: 'other' });
  }, 60_000);
  afterAll(async () => {
    await d.close();
  });

  it('suggests tax only where the section says it applies, in date order, catching up on a crossed limit', async () => {
    await issue('purchase_bill', contractor, '2025-05-10', R(20_000)); // under both limits
    await issue('purchase_bill', contractor, '2025-06-10', R(40_000)); // over INR 30,000 on its own
    await issue('purchase_bill', contractor, '2025-08-10', R(50_000)); // takes the year past INR 1 lakh
    const props = await repo.proposals(ctx, '2025-26', 'tds');
    const mine = props.filter((p) => p.partyId === contractor);
    expect(mine.map((p) => [p.date, p.basePaise, p.taxPaise])).toEqual([
      ['2025-06-10', R(40_000), R(400)],
      // 20,000 + 40,000 + 50,000 = 1,10,000 in total; 40,000 is already taxed, so 70,000 more at 1%
      ['2025-08-10', R(70_000), R(700)],
    ]);
  });

  it('does not suggest what is already recorded, and counts it as taxed', async () => {
    const [first] = (await repo.proposals(ctx, '2025-26', 'tds')).filter(
      (p) => p.partyId === contractor,
    );
    await repo.record(ctx, first!);
    const after = (await repo.proposals(ctx, '2025-26', 'tds')).filter(
      (p) => p.partyId === contractor,
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.basePaise).toBe(R(70_000));
    await expect(repo.record(ctx, first!)).rejects.toThrow(/already recorded/);
  });

  it('charges the higher rate when the payee has no PAN', async () => {
    await issue('purchase_bill', noPan, '2025-09-02', R(40_000));
    const p = (await repo.proposals(ctx, '2025-26', 'tds')).find((x) => x.partyId === noPan)!;
    expect(p.noPan).toBe(true);
    expect(p.taxPaise).toBe(R(8_000));
  });

  it('taxes rent only once the year passes INR 6 lakh, on the whole amount to date', async () => {
    for (const m of ['04', '05', '06', '07', '08', '09', '10', '11'])
      await issue('purchase_bill', rent, `2025-${m}-01`, R(70_000)); // 8 x 70,000 = 5,60,000
    expect(
      (await repo.proposals(ctx, '2025-26', 'tds')).filter((p) => p.partyId === rent),
    ).toHaveLength(0);
    await issue('purchase_bill', rent, '2025-12-01', R(70_000)); // 6,30,000
    const p = (await repo.proposals(ctx, '2025-26', 'tds')).filter((x) => x.partyId === rent);
    expect(p).toHaveLength(1);
    expect(p[0]!.basePaise).toBe(R(630_000));
    expect(p[0]!.taxPaise).toBe(R(63_000));
  });

  it('suggests TCS on a sale to a party with a nature, and not on other sales', async () => {
    await issue('tax_invoice', scrapBuyer, '2025-07-01', R(100_000));
    const t = await repo.proposals(ctx, '2025-26', 'tcs');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ nature: 'scrap', section: '206C(1)', taxPaise: R(1_000) });
  });

  it('previews a deduction by hand with the real year position', async () => {
    const p = await repo.preview(ctx, {
      kind: 'tds',
      partyId: contractor,
      rule: '194C',
      date: '2025-10-01',
      basePaise: R(10_000),
    });
    // INR 1,10,000 paid so far plus this INR 10,000; only INR 40,000 has been taxed, so INR 80,000 is caught up
    expect(p.basePaise).toBe(R(80_000));
    expect(p.taxPaise).toBe(R(800));
    await expect(
      repo.preview(ctx, {
        kind: 'tds',
        partyId: crypto.randomUUID(),
        rule: '194C',
        date: '2025-10-01',
        basePaise: 1n,
      }),
    ).rejects.toThrow(RuleError);
  });

  it('lists the recorded deductions with the party and the document number', async () => {
    const all = await repo.deductions(ctx, '2025-26');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ partyName: 'Sharma Works', section: '194C' });
    expect(all[0]!.documentNumber).toMatch(/\//);
  });

  it('records a deduction by hand and files it under the right year and quarter', async () => {
    await repo.record(ctx, {
      kind: 'tds',
      partyId: rent,
      section: '194I(b)',
      nature: null,
      date: '2026-02-10',
      basePaise: R(100_000),
      rateBp: 1000,
      taxPaise: R(10_000),
      noPan: false,
      lowerCert: false,
    });
    expect((await repo.deductions(ctx, '2025-26')).some((x) => x.date === '2026-02-10')).toBe(true);
    expect(await repo.deductions(ctx, '2026-27')).toEqual([]);
  });

  it('keeps challans, matches them to deductions of the same kind, and unmatches when removed', async () => {
    await expect(
      repo.addChallan(ctx, {
        kind: 'tds',
        fy: '2025-26',
        quarter: 'Q1',
        bsr: '12',
        depositDate: '2025-07-05',
        serial: '1',
        taxPaise: R(100),
      }),
    ).rejects.toThrow(/7 digits/);
    await expect(
      repo.addChallan(ctx, {
        kind: 'tds',
        fy: '2025-26',
        quarter: 'Q1',
        bsr: '0510308',
        depositDate: '2025-07-05',
        serial: ' ',
        taxPaise: R(100),
      }),
    ).rejects.toThrow(/serial/);
    const ch = await repo.addChallan(ctx, {
      kind: 'tds',
      fy: '2025-26',
      quarter: 'Q1',
      bsr: '0510308',
      depositDate: '2025-07-05',
      serial: '00431',
      taxPaise: R(400),
    });
    const ded = (await repo.deductions(ctx, '2025-26')).find((x) => x.partyId === contractor)!;
    await repo.mapToChallan(ctx, [ded.id], ch['id']);
    expect((await repo.deductions(ctx, '2025-26')).find((x) => x.id === ded.id)!.challanId).toBe(
      ch['id'],
    );
    expect(await repo.challans(ctx, '2025-26')).toHaveLength(1);

    const tcsCh = await repo.addChallan(ctx, {
      kind: 'tcs',
      fy: '2025-26',
      quarter: 'Q2',
      bsr: '0510308',
      depositDate: '2025-08-05',
      serial: '9',
      taxPaise: R(1),
    });
    await expect(repo.mapToChallan(ctx, [ded.id], tcsCh['id'])).rejects.toThrow(/cannot pay/);

    const fresh = (await repo.challans(ctx, '2025-26')).find((c) => c.serial === '00431')!;
    const row = (await repo.challans(ctx, '2025-26')).find((c) => c.id === fresh.id)!;
    expect(row.taxPaise).toBe(R(400));
    // version of the row is needed to remove it; read it back
    const version = Number((ch as Record<string, unknown>)['version']);
    await repo.removeChallan(ctx, ch['id'], version);
    expect(
      (await repo.deductions(ctx, '2025-26')).find((x) => x.id === ded.id)!.challanId,
    ).toBeNull();
    expect((await repo.challans(ctx, '2025-26')).some((c) => c.id === ch['id'])).toBe(false);
  });

  it('tracks tax our customers deducted from what they paid us, until the certificate arrives', async () => {
    await expect(
      repo.addReceivable(ctx, {
        partyId: scrapBuyer,
        section: '194C',
        date: '2025-08-01',
        grossPaise: R(1_000),
        tdsPaise: R(2_000),
      }),
    ).rejects.toThrow(/more than/);
    const r = await repo.addReceivable(ctx, {
      partyId: scrapBuyer,
      section: '194C',
      date: '2025-08-01',
      grossPaise: R(100_000),
      tdsPaise: R(2_000),
    });
    expect((await repo.receivables(ctx, '2025-26'))[0]).toMatchObject({
      status: 'expected',
      tdsPaise: R(2_000),
      quarter: 'Q2',
    });
    await expect(repo.setReceivableStatus(ctx, r['id'], 'certificate_received')).rejects.toThrow(
      /certificate number/,
    );
    await repo.setReceivableStatus(ctx, r['id'], 'certificate_received', {
      no: 'ABCD1234',
      date: '2025-11-01',
    });
    expect((await repo.receivables(ctx, '2025-26'))[0]).toMatchObject({
      status: 'certificate_received',
      certificateNo: 'ABCD1234',
    });
    expect(await repo.receivables(ctx, '2024-25')).toEqual([]);
  });

  it('reads turnover and profit from the books', async () => {
    expect(await repo.turnover(ctx, '2025-04-01', '2026-03-31')).toBe(R(100_000));
    expect(typeof (await repo.profitFromBooks(ctx, '2025-04-01', '2026-03-31'))).toBe('bigint');
  });
});

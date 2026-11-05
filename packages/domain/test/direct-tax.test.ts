import { describe, expect, it } from 'vitest';

import {
  DIRECT_TAX,
  advanceTaxSchedule,
  annexureCsv,
  buildReturn,
  certificateCsv,
  certificateRows,
  challanCsv,
  computeTcs,
  computeTds,
  depositDueDate,
  estimateIncomeTax,
  fyOfDate,
  interestOn,
  lateDepositInterest,
  monthsOrPart,
  periodAt,
  quarterOf,
  quarterOfFy,
  receivableSummary,
  returnDueDate,
  slabTax,
  taxYearRules,
  tdsRule,
  type ChallanRecord,
  type DeductionRecord,
  type IncomeTaxInput,
  type TdsInput,
} from '../src';

const R = (n: number | string): bigint => BigInt(Math.round(Number(n) * 100));
const PAN_OK = 'AAAPL1234C';

describe('the rules data', () => {
  it('states every limit in rupees a person can recognise', () => {
    const rupees = (p: number | undefined) => (p === undefined ? undefined : p / 100);
    const per = (s: string, d: string) => periodAt(tdsRule(s)!.periods, d)!;
    expect(rupees(per('194C', '2025-06-01').singleThresholdPaise)).toBe(30_000);
    expect(rupees(per('194C', '2025-06-01').aggregateThresholdPaise)).toBe(100_000);
    expect(rupees(per('194J', '2025-03-31').aggregateThresholdPaise)).toBe(30_000);
    expect(rupees(per('194J', '2025-04-01').aggregateThresholdPaise)).toBe(50_000);
    expect(rupees(per('194H', '2025-04-01').aggregateThresholdPaise)).toBe(20_000);
    expect(rupees(per('194I(b)', '2025-04-01').aggregateThresholdPaise)).toBe(600_000);
    expect(rupees(per('194Q', '2025-06-01').aggregateThresholdPaise)).toBe(5_000_000);
    expect(rupees(tdsRule('194Q')!.buyerTurnoverFloorPaise)).toBe(100_000_000); // INR 10 crore
    const p = DIRECT_TAX.incomeTax.presumptive;
    expect(p['44AD'].turnoverLimitPaise / 100).toBe(20_000_000); // INR 2 crore
    expect(p['44AD'].turnoverLimitDigitalPaise / 100).toBe(30_000_000); // INR 3 crore
    expect(p['44ADA'].receiptsLimitPaise / 100).toBe(5_000_000); // INR 50 lakh
    expect(p['44ADA'].receiptsLimitDigitalPaise / 100).toBe(7_500_000); // INR 75 lakh
  });

  it('is honest that nobody has verified it', () => {
    expect(DIRECT_TAX.verified).toBe(false);
  });

  it('follows a sameAs pointer to the earlier year and keeps its own assessment year', () => {
    const y = taxYearRules('2026-27')!;
    expect(y.assessmentYear).toBe('2027-28');
    expect(y.new.slabs).toEqual(taxYearRules('2025-26')!.new.slabs);
    expect(taxYearRules('2019-20')).toBeNull();
  });
});

describe('quarters and dates', () => {
  it('puts each date in its quarter, including the edges', () => {
    const q = (d: string) => {
      const x = quarterOf(d);
      return `${x.fy} ${x.quarter} ${x.from}..${x.to}`;
    };
    expect(q('2025-04-01')).toBe('2025-26 Q1 2025-04-01..2025-06-30');
    expect(q('2025-06-30')).toBe('2025-26 Q1 2025-04-01..2025-06-30');
    expect(q('2025-07-01')).toBe('2025-26 Q2 2025-07-01..2025-09-30');
    expect(q('2025-12-31')).toBe('2025-26 Q3 2025-10-01..2025-12-31');
    expect(q('2026-01-01')).toBe('2025-26 Q4 2026-01-01..2026-03-31');
    expect(q('2026-03-31')).toBe('2025-26 Q4 2026-01-01..2026-03-31');
    expect(q('2026-04-01')).toBe('2026-27 Q1 2026-04-01..2026-06-30');
    expect(fyOfDate('2026-03-31')).toBe('2025-26');
  });

  it('gives the deposit and statement due dates', () => {
    expect(depositDueDate('2025-06-15')).toBe('2025-07-07');
    expect(depositDueDate('2025-12-05')).toBe('2026-01-07');
    expect(depositDueDate('2025-03-20')).toBe('2025-04-30'); // March is the exception
    expect(returnDueDate(quarterOfFy('2025-26', 'Q1'))).toBe('2025-07-31');
    expect(returnDueDate(quarterOfFy('2025-26', 'Q2'))).toBe('2025-10-31');
    expect(returnDueDate(quarterOfFy('2025-26', 'Q3'))).toBe('2026-01-31');
    expect(returnDueDate(quarterOfFy('2025-26', 'Q4'))).toBe('2026-05-31');
  });

  it('counts a part of a month as a month', () => {
    expect(monthsOrPart('2025-01-10', '2025-01-10')).toBe(0);
    expect(monthsOrPart('2025-01-10', '2025-01-20')).toBe(1);
    expect(monthsOrPart('2025-01-10', '2025-02-10')).toBe(1);
    expect(monthsOrPart('2025-01-10', '2025-02-20')).toBe(2);
    expect(monthsOrPart('2025-03-01', '2025-02-01')).toBe(0);
    expect(lateDepositInterest(R(10_000), 2)).toBe(R(300)); // 1.5% a month
  });
});

const base = (o: Partial<TdsInput>): TdsInput => ({
  section: '194C',
  date: '2025-08-10',
  basePaise: R(40_000),
  pan: PAN_OK,
  category: 'individual_huf',
  cumulativeBeforePaise: 0n,
  alreadyBasePaise: 0n,
  ...o,
});

describe('TDS by section', () => {
  const cases: [string, Partial<TdsInput>, bigint, number][] = [
    ['194C under both limits', { basePaise: R(20_000) }, 0n, 0],
    ['194C single payment over INR 30,000, individual', {}, R(400), 100],
    ['194C single payment over the limit, company', { category: 'other' }, R(800), 200],
    [
      '194C year total crosses INR 1 lakh: tax on everything not yet taxed',
      { basePaise: R(20_000), cumulativeBeforePaise: R(90_000) },
      R(1_100),
      100,
    ],
    [
      '194C catch-up leaves out what was already taxed',
      { basePaise: R(20_000), cumulativeBeforePaise: R(90_000), alreadyBasePaise: R(40_000) },
      R(700),
      100,
    ],
    [
      '194J professional, threshold INR 30,000 before April 2025',
      { section: '194J', kind: 'professional', date: '2025-03-31', basePaise: R(40_000) },
      R(4_000),
      1000,
    ],
    [
      '194J under the old threshold',
      { section: '194J', kind: 'professional', date: '2025-03-31', basePaise: R(25_000) },
      0n,
      0,
    ],
    [
      '194J, INR 40,000 is under the new threshold of INR 50,000',
      { section: '194J', kind: 'professional', date: '2025-04-01', basePaise: R(40_000) },
      0n,
      0,
    ],
    [
      '194J professional above the new threshold',
      { section: '194J', kind: 'professional', date: '2025-04-01', basePaise: R(60_000) },
      R(6_000),
      1000,
    ],
    [
      '194J technical service at 2%',
      { section: '194J', kind: 'technical', date: '2025-04-01', basePaise: R(60_000) },
      R(1_200),
      200,
    ],
    [
      '194H at 5% before October 2024',
      { section: '194H', date: '2024-09-01', basePaise: R(20_000) },
      R(1_000),
      500,
    ],
    [
      '194H at 2% from 1 October 2024',
      { section: '194H', date: '2024-10-15', basePaise: R(20_000) },
      R(400),
      200,
    ],
    [
      '194H threshold rises to INR 20,000 from April 2025',
      { section: '194H', date: '2025-04-10', basePaise: R(20_000) },
      0n,
      0,
    ],
    ['194H above it', { section: '194H', date: '2025-04-10', basePaise: R(25_000) }, R(500), 200],
    [
      '194I(b) crossing INR 6 lakh taxes the whole year to date',
      {
        section: '194I(b)',
        date: '2025-06-01',
        basePaise: R(70_000),
        cumulativeBeforePaise: R(550_000),
      },
      R(62_000),
      1000,
    ],
    [
      '194I(a) at 2%',
      {
        section: '194I(a)',
        date: '2025-06-01',
        basePaise: R(70_000),
        cumulativeBeforePaise: R(550_000),
      },
      R(12_400),
      200,
    ],
    [
      '194Q only on the part above INR 50 lakh',
      {
        section: '194Q',
        date: '2025-08-01',
        basePaise: R(3_000_000),
        cumulativeBeforePaise: R(4_000_000),
      },
      R(2_000),
      10,
    ],
    [
      '194Q while the year total is inside INR 50 lakh',
      { section: '194Q', basePaise: R(4_000_000) },
      0n,
      0,
    ],
  ];
  it.each(cases)('%s', (_name, over, tax, rate) => {
    const d = computeTds(base(over));
    expect(d.taxPaise).toBe(tax);
    expect(d.applies).toBe(tax > 0n);
    if (tax > 0n) expect(d.rateBp).toBe(rate);
  });

  it('rounds the tax to the nearest rupee', () => {
    // 1% of INR 33,333.33 is INR 333.3333, which is INR 333
    expect(computeTds(base({ basePaise: 3_333_333n })).taxPaise).toBe(R(333));
  });

  it('charges 20% when the payee has no PAN, and 5% under 194Q', () => {
    expect(computeTds(base({ pan: '' })).taxPaise).toBe(R(8_000));
    expect(computeTds(base({ pan: 'not a pan' })).noPan).toBe(true);
    const q = computeTds(
      base({
        section: '194Q',
        pan: '',
        basePaise: R(3_000_000),
        cumulativeBeforePaise: R(4_000_000),
      }),
    );
    expect(q.taxPaise).toBe(R(100_000));
  });

  it('skips 194Q for a buyer under INR 10 crore, and checks it only when the turnover is known', () => {
    const o = { section: '194Q', basePaise: R(3_000_000), cumulativeBeforePaise: R(4_000_000) };
    expect(computeTds(base({ ...o, buyerTurnoverPaise: R(90_000_000) })).applies).toBe(false);
    expect(computeTds(base({ ...o, buyerTurnoverPaise: R(100_000_001) })).applies).toBe(true);
    expect(computeTds(base(o)).applies).toBe(true);
  });

  it('uses a lower-deduction certificate inside its dates and its limit', () => {
    const lower = {
      rateBp: 100,
      validFrom: '2025-04-01',
      validTo: '2026-03-31',
      limitPaise: R(60_000),
    };
    const o = {
      section: '194J',
      kind: 'professional' as const,
      basePaise: R(100_000),
      date: '2025-09-01',
    };
    // INR 60,000 at 1% and the other INR 40,000 at 10%
    expect(computeTds(base({ ...o, lower })).taxPaise).toBe(R(4_600));
    expect(computeTds(base({ ...o, lower })).lowerCert).toBe(true);
    expect(computeTds(base({ ...o, lower, date: '2026-04-01' })).taxPaise).toBe(R(10_000));
    expect(computeTds(base({ ...o, lower: { ...lower, usedPaise: R(60_000) } })).taxPaise).toBe(
      R(10_000),
    );
    expect(computeTds(base({ ...o, lower, pan: '' })).lowerCert).toBe(false);
  });

  it('says so for a section it does not know or that is not in force', () => {
    expect(computeTds(base({ section: '194ZZ' })).applies).toBe(false);
    expect(
      computeTds(base({ section: '194Q', date: '2021-06-30', basePaise: R(9_000_000) })).applies,
    ).toBe(false);
  });

  it('carries a trace of each step', () => {
    const d = computeTds(base({}));
    expect(d.trace.map((t) => t.rule)).toEqual(['tds.single', 'tds.tax']);
  });
});

describe('TCS', () => {
  const t = (nature: string, date: string, baseRs: number, cum = 0, pan = PAN_OK) =>
    computeTcs({ nature, date, basePaise: R(baseRs), pan, cumulativeBeforePaise: R(cum) });

  it('collects 1% on scrap, and 5% when the buyer has no PAN', () => {
    expect(t('scrap', '2025-05-01', 100_000).taxPaise).toBe(R(1_000));
    expect(t('scrap', '2025-05-01', 100_000, 0, '').taxPaise).toBe(R(5_000));
  });

  it('collects on a motor vehicle only above INR 10 lakh', () => {
    expect(t('motor_vehicle', '2025-05-01', 900_000).applies).toBe(false);
    expect(t('motor_vehicle', '2025-05-01', 1_200_000).taxPaise).toBe(R(12_000));
  });

  it('206C(1H) taxes only the part above INR 50 lakh, and ends on 31 March 2025', () => {
    expect(t('sale_of_goods', '2025-03-31', 200_000, 4_900_000).taxPaise).toBe(R(100));
    expect(t('sale_of_goods', '2025-03-31', 200_000, 100_000).applies).toBe(false);
    expect(t('sale_of_goods', '2025-04-01', 200_000, 4_900_000).applies).toBe(false);
    expect(t('sale_of_goods', '2020-09-30', 200_000, 4_900_000).applies).toBe(false);
    expect(t('nothing_like_this', '2025-05-01', 1).applies).toBe(false);
  });
});

const ded = (o: Partial<DeductionRecord>): DeductionRecord => ({
  id: 'd',
  kind: 'tds',
  partyId: 'p1',
  partyName: 'Sharma Traders',
  pan: PAN_OK,
  deducteeType: null,
  section: '194C',
  nature: null,
  date: '2025-08-10',
  basePaise: R(40_000),
  rateBp: 100,
  taxPaise: R(400),
  noPan: false,
  lowerCert: false,
  challanId: null,
  documentNumber: 'PB/001',
  ...o,
});
const challan = (o: Partial<ChallanRecord>): ChallanRecord => ({
  id: 'c1',
  kind: 'tds',
  section: null,
  bsr: '0510308',
  depositDate: '2025-09-05',
  serial: '00431',
  taxPaise: R(1_100),
  interestPaise: 0n,
  feePaise: 0n,
  ...o,
});

describe('26Q and 27EQ', () => {
  const q2 = quarterOfFy('2025-26', 'Q2');
  const rows = [
    ded({ id: 'a', date: '2025-08-10', challanId: 'c1' }),
    ded({
      id: 'b',
      date: '2025-08-20',
      partyId: 'p2',
      partyName: 'Kumar & Sons Pvt Ltd',
      pan: 'AABCK1234F',
      section: '194J',
      basePaise: R(60_000),
      rateBp: 1000,
      taxPaise: R(6_000),
      challanId: 'c1',
    }),
    ded({
      id: 'x',
      date: '2025-07-02',
      partyId: 'p3',
      partyName: 'Outside the quarter',
      section: '194C',
      challanId: null,
      pan: '',
      noPan: true,
    }),
    ded({ id: 'y', date: '2025-05-02', partyName: 'Q1 deduction' }),
  ];

  it('lists the quarter, its totals and the challans', () => {
    const r = buildReturn('tds', q2, rows, [challan({ taxPaise: R(6_400) })]);
    expect(r.form).toBe('26Q');
    expect(r.dueDate).toBe('2025-10-31');
    expect(r.rows.map((x) => x.name)).toEqual([
      'Outside the quarter',
      'Sharma Traders',
      'Kumar & Sons Pvt Ltd',
    ]);
    expect(r.rows[2]).toMatchObject({ partyCode: '01', code: '94J', serial: 3 });
    expect(r.rows[0]).toMatchObject({ pan: 'PANNOTAVBL', reason: 'C' });
    expect(r.totals).toMatchObject({
      taxPaise: R(6_800),
      basePaise: R(140_000),
      deductions: 3,
      depositedPaise: R(6_400),
    });
    expect(r.challans).toHaveLength(1);
    expect(r.challans[0]).toMatchObject({
      mappedPaise: R(6_400),
      differencePaise: 0n,
      late: false,
      dueDate: '2025-09-07',
    });
  });

  it('raises a problem for a missing PAN, an unmatched deduction, a short or late challan', () => {
    const r = buildReturn('tds', q2, rows, [
      challan({ taxPaise: R(1_000), depositDate: '2025-09-20' }),
      challan({ id: 'c9', serial: '9' }),
    ]);
    const codes = r.problems.map((p) => p.code).sort();
    expect(codes).toEqual([
      'challan_short',
      'challan_unused',
      'late_deposit',
      'no_challan',
      'no_pan',
    ]);
    expect(r.problems.find((p) => p.code === 'no_pan')!.severity).toBe('error');
  });

  it('writes the annexure and the challan summary as CSV (layout snapshot)', () => {
    const r = buildReturn('tds', q2, rows.slice(0, 2), [challan({ taxPaise: R(6_400) })]);
    const lines = annexureCsv(r)
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines[0]).toBe(
      'Sr. No.,Deductee Code,PAN of Deductee,Name of Deductee,Section Code,Date of Payment/Credit,Amount Paid/Credited,Rate %,Tax Deducted,Date of Deposit,BSR Code,Challan Serial No.,Reason for Lower or Higher Rate,Document',
    );
    expect(lines[1]).toBe(
      '1,02,AAAPL1234C,Sharma Traders,94C,2025-08-10,40000.00,1.00,400.00,2025-09-05,0510308,00431,,PB/001',
    );
    expect(lines[2]).toBe(
      '2,01,AABCK1234F,Kumar & Sons Pvt Ltd,94J,2025-08-20,60000.00,10.00,6000.00,2025-09-05,0510308,00431,,PB/001',
    );
    expect(lines[3]).toBe(',,,Total,,,100000.00,,6400.00,,,,,');
    const ch = challanCsv(r)
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(ch[0]).toBe(
      'BSR Code,Date of Deposit,Challan Serial No.,Tax Deposited,Interest,Fee,Tax Matched To Deductions,Difference,Due Date,Late',
    );
    expect(ch[1]).toBe('0510308,2025-09-05,00431,6400.00,0.00,0.00,6400.00,0.00,2025-09-07,N');
  });

  it('builds the TCS statement as 27EQ with its nature codes', () => {
    const tcs = ded({
      id: 't',
      kind: 'tcs',
      section: '206C(1)',
      nature: 'scrap',
      basePaise: R(100_000),
      rateBp: 100,
      taxPaise: R(1_000),
    });
    const r = buildReturn('tcs', q2, [tcs, ded({})], []);
    expect(r.form).toBe('27EQ');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.code).toBe('6CE');
    expect(annexureCsv(r)).toContain('Collectee Code');
  });

  it('gives the data of one party for Form 16A', () => {
    const rowsA = certificateRows('tds', q2, 'p1', rows, [challan({})]);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({
      partyName: 'Sharma Traders',
      bsr: '0510308',
      quarter: '2025-26 Q2',
    });
    // a deduction with no challan yet has empty challan fields
    expect(certificateRows('tds', q2, 'p1', [ded({})], [challan({})])[0]).toMatchObject({
      bsr: '',
      challanSerial: '',
    });
    const withChallan = certificateRows('tds', q2, 'p1', [ded({ challanId: 'c1' })], [challan({})]);
    expect(withChallan[0]).toMatchObject({ bsr: '0510308', challanSerial: '00431' });
    expect(certificateCsv('tds', withChallan)).toContain('Sharma Traders');
  });
});

describe('TDS receivable', () => {
  it('totals by year and shows what to chase', () => {
    const row = (
      id: string,
      status: 'expected' | 'certificate_received' | 'claimed',
      tds: number,
      fy = '2025-26',
    ) => ({
      id,
      partyId: 'p',
      partyName: 'P',
      fy,
      quarter: 'Q1',
      section: '194C',
      date: '2025-05-01',
      grossPaise: R(tds * 10),
      tdsPaise: R(tds),
      certificateNo: '',
      status,
    });
    const s = receivableSummary([
      row('1', 'expected', 100),
      row('2', 'certificate_received', 200),
      row('3', 'claimed', 300),
      row('4', 'expected', 50, '2024-25'),
    ]);
    expect(s[0]).toEqual({
      fy: '2025-26',
      expectedPaise: R(600),
      certificatePaise: R(500),
      claimedPaise: R(300),
      toChasePaise: R(100),
    });
    expect(s[1]!.fy).toBe('2024-25');
  });
});

describe('income tax slabs and regimes (2025-26)', () => {
  const rules = taxYearRules('2025-26')!;
  const newTax = (rs: number) => slabTax(R(rs), rules.new.slabs);
  const oldTax = (rs: number) => slabTax(R(rs), rules.old.slabsByAge.below60);

  it('computes new-regime slab tax by hand', () => {
    expect(newTax(400_000)).toBe(0n);
    expect(newTax(1_200_000)).toBe(R(60_000));
    expect(newTax(1_500_000)).toBe(R(105_000));
    expect(newTax(2_400_000)).toBe(R(300_000));
    expect(newTax(3_000_000)).toBe(R(480_000));
  });
  it('computes old-regime slab tax by hand', () => {
    expect(oldTax(250_000)).toBe(0n);
    expect(oldTax(500_000)).toBe(R(12_500));
    expect(oldTax(1_000_000)).toBe(R(112_500));
    expect(slabTax(R(350_000), rules.old.slabsByAge.senior)).toBe(R(2_500));
    expect(slabTax(R(600_000), rules.old.slabsByAge.super_senior)).toBe(R(20_000));
  });

  const input = (o: Partial<IncomeTaxInput> = {}): IncomeTaxInput => ({
    fy: '2025-26',
    age: 'below60',
    business: { method: 'books', netProfitPaise: R(1_400_000) },
    otherIncomePaise: 0n,
    deductions: {
      section80C: 0n,
      section80CCD1B: 0n,
      section80DSelf: 0n,
      section80DParents: 0n,
      parentsSenior: false,
      homeLoanInterest: 0n,
      other: 0n,
    },
    creditPaise: 0n,
    advance: [],
    ...o,
  });
  const est = (o: Partial<IncomeTaxInput> = {}) => {
    const e = estimateIncomeTax(input(o));
    if ('error' in e) throw new Error(e.error);
    return e;
  };

  it('applies the rebate: no tax up to INR 12 lakh in the new regime, INR 5 lakh in the old', () => {
    expect(
      est({ business: { method: 'books', netProfitPaise: R(1_200_000) } }).new.totalTaxPaise,
    ).toBe(0n);
    expect(
      est({ business: { method: 'books', netProfitPaise: R(500_000) } }).old.totalTaxPaise,
    ).toBe(0n);
    expect(est({ business: { method: 'books', netProfitPaise: R(500_000) } }).old.rebatePaise).toBe(
      R(12_500),
    );
  });

  it('gives marginal relief just above INR 12 lakh', () => {
    const e = est({ business: { method: 'books', netProfitPaise: R(1_210_000) } });
    expect(e.new.slabTaxPaise).toBe(R(61_500));
    expect(e.new.rebatePaise).toBe(R(51_500));
    // INR 10,000 of tax plus 4% cess
    expect(e.new.totalTaxPaise).toBe(R(10_400));
  });

  it('adds cess and rounds to ten rupees', () => {
    const e = est();
    expect(e.new.totalTaxPaise).toBe(R(93_600));
    expect(e.old.totalTaxPaise).toBe(R(241_800));
    expect(e.better).toBe('new');
    expect(e.savingPaise).toBe(R(148_200));
    expect(
      est({ business: { method: 'books', netProfitPaise: R(2_400_000) } }).new.totalTaxPaise,
    ).toBe(R(312_000));
  });

  it('caps old-regime deductions at their limits and ignores them in the new regime', () => {
    const e = est({
      deductions: {
        section80C: R(200_000),
        section80CCD1B: R(80_000),
        section80DSelf: R(40_000),
        section80DParents: R(60_000),
        parentsSenior: true,
        homeLoanInterest: R(250_000),
        other: 0n,
      },
    });
    // 1.5L + 50k + 25k + 50k + 2L
    expect(e.old.deductionsPaise).toBe(R(475_000));
    expect(e.new.deductionsPaise).toBe(0n);
    expect(e.old.taxableIncomePaise).toBe(R(925_000));
  });

  it('adds surcharge, with marginal relief just over INR 50 lakh', () => {
    const big = est({ business: { method: 'books', netProfitPaise: R(6_000_000) } });
    expect(big.new.surchargePaise).toBe(R(138_000));
    expect(big.new.totalTaxPaise).toBe(R(1_578_720));
    const edge = est({ business: { method: 'books', netProfitPaise: R(5_050_000) } });
    expect(edge.new.surchargePaise).toBe(R(35_000));
    expect(edge.new.totalTaxPaise).toBe(R(1_175_200));
  });

  it('rounds the taxable income down to ten rupees', () => {
    expect(
      est({ business: { method: 'books', netProfitPaise: R(1_200_009) } }).new.taxableIncomePaise,
    ).toBe(R(1_200_000));
  });

  it('works out presumptive income under 44AD and 44ADA and warns about the limits', () => {
    expect(
      est({ business: { method: '44AD', turnoverPaise: R(5_000_000), digitalShareBp: 10_000 } }).new
        .incomePaise,
    ).toBe(R(300_000));
    expect(
      est({ business: { method: '44AD', turnoverPaise: R(5_000_000), digitalShareBp: 5_000 } }).new
        .incomePaise,
    ).toBe(R(350_000));
    expect(
      est({ business: { method: '44ADA', receiptsPaise: R(2_000_000), cashShareBp: 0 } }).new
        .incomePaise,
    ).toBe(R(1_000_000));
    expect(
      est({
        business: { method: '44AD', turnoverPaise: R(25_000_000), digitalShareBp: 10_000 },
      }).warnings.join(' '),
    ).not.toMatch(/limit for section 44AD/);
    expect(
      est({
        business: { method: '44AD', turnoverPaise: R(25_000_000), digitalShareBp: 9_000 },
      }).warnings.join(' '),
    ).toMatch(/limit for section 44AD/);
    expect(
      est({
        business: { method: '44ADA', receiptsPaise: R(6_000_000), cashShareBp: 1_000 },
      }).warnings.join(' '),
    ).toMatch(/limit for section 44ADA/);
    expect(
      est({ business: { method: '44AD', turnoverPaise: 1n, digitalShareBp: 10_000 } }).presumptive,
    ).toBe(true);
  });

  it('takes a loss as nil and says so, and refuses a year it has no rules for', () => {
    const e = est({ business: { method: 'books', netProfitPaise: -R(100_000) } });
    expect(e.new.totalTaxPaise).toBe(0n);
    expect(e.warnings.join(' ')).toMatch(/loss/);
    expect('error' in estimateIncomeTax(input({ fy: '2019-20' }))).toBe(true);
  });

  it('always warns that the rules are unverified, and flags an assumed year', () => {
    expect(est().warnings.join(' ')).toMatch(/not yet verified/);
    expect(est({ fy: '2026-27' }).warnings.join(' ')).toMatch(/Assumed unchanged/);
  });
});

describe('advance tax and interest', () => {
  const fy = '2025-26';
  const filing = '2026-07-31';

  it('lists the instalments with the running total', () => {
    expect(advanceTaxSchedule(fy, R(100_000), false)).toEqual([
      { dueDate: '2025-06-15', cumulativePaise: R(15_000) },
      { dueDate: '2025-09-15', cumulativePaise: R(45_000) },
      { dueDate: '2025-12-15', cumulativePaise: R(75_000) },
      { dueDate: '2026-03-15', cumulativePaise: R(100_000) },
    ]);
    expect(advanceTaxSchedule(fy, R(100_000), true)).toEqual([
      { dueDate: '2026-03-15', cumulativePaise: R(100_000) },
    ]);
    expect(advanceTaxSchedule(fy, R(9_999), false)).toEqual([]);
  });

  it('charges 234B and 234C when nothing was paid', () => {
    const r = interestOn(fy, R(100_000), false, [], filing);
    expect(r.instalments.map((x) => x.interestPaise)).toEqual([
      R(450),
      R(1_350),
      R(2_250),
      R(1_000),
    ]);
    expect(r.section234CPaise).toBe(R(5_050));
    expect(r.section234BMonths).toBe(4);
    expect(r.section234BPaise).toBe(R(4_000));
    expect(r.totalPaise).toBe(R(9_050));
  });

  it('charges nothing when each instalment was paid on time', () => {
    const r = interestOn(
      fy,
      R(100_000),
      false,
      [
        { date: '2025-06-10', paise: R(15_000) },
        { date: '2025-09-10', paise: R(30_000) },
        { date: '2025-12-10', paise: R(30_000) },
        { date: '2026-03-10', paise: R(25_000) },
      ],
      filing,
    );
    expect(r.totalPaise).toBe(0n);
  });

  it('relaxes the first two instalments to 12% and 36%', () => {
    const r = interestOn(fy, R(100_000), false, [{ date: '2025-06-10', paise: R(12_000) }], filing);
    expect(r.instalments[0]!.interestPaise).toBe(0n);
    expect(r.instalments[1]!.interestPaise).toBe(R(990));
  });

  it('asks a presumptive taxpayer for the whole tax by 15 March', () => {
    const r = interestOn(fy, R(100_000), true, [], filing);
    expect(r.instalments).toHaveLength(1);
    expect(r.section234CPaise).toBe(R(1_000));
    expect(r.section234BPaise).toBe(R(4_000));
  });

  it('charges nothing below INR 10,000 of tax, or when 90% was paid by the year end', () => {
    expect(interestOn(fy, R(9_999), false, [], filing).totalPaise).toBe(0n);
    const late = interestOn(
      fy,
      R(100_000),
      false,
      [{ date: '2026-03-14', paise: R(95_000) }],
      filing,
    );
    expect(late.section234BPaise).toBe(0n);
    expect(late.section234CPaise).toBeGreaterThan(0n);
  });

  it('feeds the estimate: tax left to pay after credits, advance tax and interest', () => {
    const e = estimateIncomeTax({
      fy,
      age: 'below60',
      business: { method: 'books', netProfitPaise: R(1_400_000) },
      otherIncomePaise: 0n,
      deductions: {
        section80C: 0n,
        section80CCD1B: 0n,
        section80DSelf: 0n,
        section80DParents: 0n,
        parentsSenior: false,
        homeLoanInterest: 0n,
        other: 0n,
      },
      creditPaise: R(20_000),
      advance: [],
    });
    if ('error' in e) throw new Error(e.error);
    expect(e.interest.new.assessedPaise).toBe(R(73_600));
    expect(e.payablePaise.new).toBe(R(73_600) + e.interest.new.totalPaise);
  });
});

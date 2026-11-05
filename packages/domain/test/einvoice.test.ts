import { describe, expect, it } from 'vitest';

import {
  EINVOICE_RULES_V1_1,
  buildEinvoice,
  buildEwb,
  checkEinvoice,
  checkEwb,
  ewbCancellable,
  ewbExtendable,
  EWB_RULES_V1,
  ewbRequired,
  ewbThreshold,
  ewbValidUntil,
  explainGspError,
  gstinCheckChar,
  irnCancellable,
  needsIrn,
  partBRequired,
  type EinvDoc,
  type EinvLine,
  type EinvSupply,
  type EwbInput,
} from '../src';

const g = (first14: string) => first14 + gstinCheckChar(first14);
const SELLER = g('27AAPFU0939F1Z'); // Maharashtra
const BUYER_KA = g('29AABCU9603R1Z'); // Karnataka
const BUYER_MH = g('27AABCU9603R1Z'); // Maharashtra

const ctx = { today: '2025-05-02', turnoverPaise: 0 };

const line = (o: Partial<EinvLine> = {}): EinvLine => ({
  description: 'Steel flask 1 litre',
  hsn: '732393',
  qtyMicros: 2_000_000,
  uqc: 'NOS',
  unitPricePaise: 50_000,
  grossPaise: 100_000,
  discountPaise: 0,
  taxablePaise: 100_000,
  gstRateBp: 1800,
  igstPaise: 18_000,
  cgstPaise: 0,
  sgstPaise: 0,
  cessRateBp: 0,
  cessPaise: 0,
  otherChargesPaise: 0,
  totalPaise: 118_000,
  ...o,
});

function doc(supply: EinvSupply = 'B2B', o: Partial<EinvDoc> = {}): EinvDoc {
  const exporting = supply === 'EXPWP' || supply === 'EXPWOP';
  const lines = o.lines ?? [line()];
  const sum = (k: keyof EinvLine) => lines.reduce((a, l) => a + Number(l[k]), 0);
  return {
    kind: 'INV',
    number: 'INV/24-25/0042',
    date: '2025-05-01',
    supply,
    reverseCharge: false,
    seller: {
      gstin: SELLER,
      legalName: 'Demo Traders Private Limited',
      addr1: '12 MG Road',
      location: 'Pune',
      pincode: '411001',
      stateCode: '27',
    },
    buyer: {
      gstin: exporting ? 'URP' : BUYER_KA,
      legalName: exporting ? 'Overseas Buyer LLC' : 'Acme Retail',
      addr1: exporting ? '1 Harbour St' : '5 Brigade Road',
      location: exporting ? 'Dubai' : 'Bengaluru',
      pincode: exporting ? '999999' : '560001',
      stateCode: exporting ? '96' : '29',
      pos: exporting ? '96' : '29',
    },
    lines,
    totals: {
      assessablePaise: sum('taxablePaise'),
      cgstPaise: sum('cgstPaise'),
      sgstPaise: sum('sgstPaise'),
      igstPaise: sum('igstPaise'),
      cessPaise: sum('cessPaise'),
      discountPaise: 0,
      otherChargesPaise: 0,
      roundOffPaise: 0,
      totalPaise: sum('totalPaise'),
    },
    ...o,
  };
}

const at = (j: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((a, k) => (a as Record<string | number, unknown>)[k], j);

describe('the e-invoice payload (schema 1.1)', () => {
  it('writes a B2B inter-state invoice in the portal layout, in rupees and DD/MM/YYYY', () => {
    const j = buildEinvoice(doc());
    expect(j['Version']).toBe('1.1');
    expect(j['TranDtls']).toEqual({ TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' });
    expect(j['DocDtls']).toEqual({ Typ: 'INV', No: 'INV/24-25/0042', Dt: '01/05/2025' });
    expect(at(j, 'SellerDtls')).toMatchObject({ Gstin: SELLER, Pin: 411001, Stcd: '27' });
    expect(at(j, 'BuyerDtls')).toMatchObject({ Gstin: BUYER_KA, Pos: '29', Pin: 560001 });
    expect(at(j, 'ItemList', 0)).toMatchObject({
      SlNo: '1',
      IsServc: 'N',
      HsnCd: '732393',
      Qty: 2,
      Unit: 'NOS',
      UnitPrice: 500,
      TotAmt: 1000,
      AssAmt: 1000,
      GstRt: 18,
      IgstAmt: 180,
      CgstAmt: 0,
      TotItemVal: 1180,
    });
    expect(at(j, 'ValDtls')).toMatchObject({ AssVal: 1000, IgstVal: 180, TotInvVal: 1180 });
    expect(checkEinvoice(doc(), ctx)).toEqual([]);
  });

  it.each([
    [
      'B2B intra-state',
      'B2B',
      {
        buyer: {
          gstin: BUYER_MH,
          legalName: 'Local Co',
          addr1: 'x',
          location: 'Mumbai',
          pincode: '400001',
          stateCode: '27',
          pos: '27',
        },
        lines: [line({ igstPaise: 0, cgstPaise: 9_000, sgstPaise: 9_000 })],
      },
    ],
    ['SEZ with payment', 'SEZWP', {}],
    [
      'SEZ without payment',
      'SEZWOP',
      { lines: [line({ gstRateBp: 0, igstPaise: 0, totalPaise: 100_000 })] },
    ],
    [
      'export with payment',
      'EXPWP',
      {
        exportDetails: {
          shippingBillNo: '1234567',
          shippingBillDate: '2025-05-01',
          portCode: 'INNSA1',
          currency: 'USD',
          countryCode: 'AE',
        },
      },
    ],
    [
      'export without payment',
      'EXPWOP',
      { lines: [line({ gstRateBp: 0, igstPaise: 0, totalPaise: 100_000 })] },
    ],
    ['deemed export', 'DEXP', {}],
  ] as [string, EinvSupply, Partial<EinvDoc>][])(
    '%s passes the checks and says so in TranDtls',
    (_name, supply, o) => {
      const d = doc(supply, o);
      expect(checkEinvoice(d, ctx)).toEqual([]);
      expect(at(buildEinvoice(d), 'TranDtls', 'SupTyp')).toBe(supply);
    },
  );

  it('writes the export details only for an export', () => {
    const exp = doc('EXPWP', {
      exportDetails: {
        shippingBillNo: 'SB1',
        shippingBillDate: '2025-05-02',
        portCode: 'INNSA1',
        currency: 'USD',
        countryCode: 'AE',
      },
    });
    expect(buildEinvoice(exp)['ExpDtls']).toEqual({
      ShipBNo: 'SB1',
      ShipBDt: '02/05/2025',
      Port: 'INNSA1',
      ForCur: 'USD',
      CntCode: 'AE',
    });
    expect(
      buildEinvoice(doc('B2B', { exportDetails: { shippingBillNo: 'SB1' } }))['ExpDtls'],
    ).toBeUndefined();
  });

  it('names the invoice a note corrects, and asks for it', () => {
    const cn = doc('B2B', {
      kind: 'CRN',
      number: 'CN/0001',
      preceding: { number: 'INV/24-25/0042', date: '2025-04-20' },
    });
    expect(buildEinvoice(cn)['RefDtls']).toEqual({
      PrecDocDtls: [{ InvNo: 'INV/24-25/0042', InvDt: '20/04/2025' }],
    });
    expect(checkEinvoice(doc('B2B', { kind: 'CRN' }), ctx).map((p) => p.code)).toContain(
      'preceding',
    );
  });

  it('marks a service line and reverse charge', () => {
    const j = buildEinvoice(
      doc('B2B', {
        reverseCharge: true,
        lines: [line({ hsn: '998314', description: 'IT support services' })],
      }),
    );
    expect(at(j, 'ItemList', 0, 'IsServc')).toBe('Y');
    expect(at(j, 'TranDtls', 'RegRev')).toBe('Y');
  });

  it('catches what the portal would refuse, with where and why', () => {
    const codes = (d: EinvDoc, c = ctx) => checkEinvoice(d, c).map((p) => p.code);
    expect(codes(doc('B2B', { number: '0123' }))).toContain('doc_number');
    expect(codes(doc('B2B', { number: 'INVOICE/2025/000001' }))).toContain('doc_number');
    expect(codes(doc('B2B', { date: '2025-05-09' }))).toContain('doc_date_future');
    expect(codes(doc('B2B', { buyer: { ...doc().buyer, gstin: '29AABCU9603R1ZZ' } }))).toContain(
      'gstin',
    );
    expect(codes(doc('B2B', { buyer: { ...doc().buyer, pincode: '56001' } }))).toContain('pincode');
    expect(
      codes(doc('B2B', { buyer: { ...doc().buyer, gstin: SELLER, pos: '27', stateCode: '27' } })),
    ).toContain('self');
    expect(codes(doc('B2B', { lines: [line({ hsn: '73' })] }))).toContain('hsn');
    expect(
      codes(
        doc('B2B', { lines: [line({ gstRateBp: 1700, igstPaise: 17_000, totalPaise: 117_000 })] }),
      ),
    ).toContain('rate');
    expect(
      codes(doc('B2B', { lines: [line({ igstPaise: 10_000, totalPaise: 110_000 })] })),
    ).toContain('tax');
    expect(
      codes(doc('B2B', { lines: [line({ cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0 })] })),
    ).toContain('inter_heads');
    expect(codes(doc('B2B', { lines: [line({ description: 'x' })] }))).toContain('description');
    expect(codes(doc('B2B', { lines: [] }))).toContain('no_lines');
    expect(codes(doc('SEZWOP'))).toContain('without_payment');
    expect(codes(doc('EXPWP', { buyer: { ...doc('EXPWP').buyer, pincode: '400001' } }))).toContain(
      'pincode',
    );
    const bad = doc();
    bad.totals = { ...bad.totals, totalPaise: bad.totals.totalPaise + 500 };
    expect(codes(bad)).toContain('total');
    bad.totals = {
      ...doc().totals,
      roundOffPaise: 10_000,
      totalPaise: doc().totals.totalPaise + 10_000,
    };
    expect(codes(bad)).toContain('round_off');
  });

  it('applies the turnover rules: six HSN digits above INR 5 crore, and 30 days above INR 10 crore', () => {
    const big = { today: '2025-06-15', turnoverPaise: 12_00_00_000 * 100 };
    const old = doc('B2B', { date: '2025-05-01', lines: [line({ hsn: '7323' })] });
    const codes = checkEinvoice(old, big).map((p) => p.code);
    expect(codes).toContain('hsn_digits');
    expect(codes).toContain('doc_too_old');
    // before the age limit took effect, or for a smaller business, no age problem
    expect(
      checkEinvoice(old, { today: '2025-03-15', turnoverPaise: big.turnoverPaise }).map(
        (p) => p.code,
      ),
    ).not.toContain('doc_too_old');
    expect(
      checkEinvoice(old, { today: '2025-06-15', turnoverPaise: 6_00_00_000 * 100 }).map(
        (p) => p.code,
      ),
    ).toEqual(['hsn_digits']);
  });

  it('knows the 24-hour cancellation window, counted from the acknowledgement in IST', () => {
    expect(irnCancellable('2025-05-01 10:00:00', new Date('2025-05-02T04:00:00Z'))).toBe(true); // 23.5 h
    expect(irnCancellable('2025-05-01 10:00:00', new Date('2025-05-02T05:00:00Z'))).toBe(false); // 24.5 h
    expect(irnCancellable('not a date', new Date())).toBe(false);
  });

  it('decides which documents need an IRN', () => {
    const base = {
      einvoicingOn: true,
      type: 'tax_invoice',
      status: 'issued',
      registered: true,
      supplyType: 'inter',
    };
    expect(needsIrn(base)).toBe(true);
    expect(needsIrn({ ...base, einvoicingOn: false })).toBe(false);
    expect(needsIrn({ ...base, status: 'draft' })).toBe(false);
    expect(needsIrn({ ...base, type: 'bill_of_supply' })).toBe(false);
    expect(needsIrn({ ...base, registered: false })).toBe(false);
    expect(needsIrn({ ...base, registered: false, supplyType: 'export' })).toBe(true);
    expect(needsIrn({ ...base, type: 'credit_note' })).toBe(true);
  });

  it('keeps the rules as data and says they are not verified', () => {
    expect(EINVOICE_RULES_V1_1.verified).toBe(false);
    expect(EINVOICE_RULES_V1_1.cancelHours).toBe(24);
  });
});

const ewb = (o: Partial<EwbInput> = {}): EwbInput => ({
  docType: 'tax_invoice',
  number: 'INV/24-25/0042',
  date: '2025-05-01',
  supplyType: 'O',
  subSupplyType: '1',
  from: {
    gstin: SELLER,
    name: 'Demo Traders',
    addr1: '12 MG Road',
    place: 'Pune',
    pincode: '411001',
    stateCode: '27',
  },
  to: {
    gstin: BUYER_KA,
    name: 'Acme Retail',
    addr1: '5 Brigade Road',
    place: 'Bengaluru',
    pincode: '560001',
    stateCode: '29',
  },
  transactionType: 1,
  values: {
    taxablePaise: 10_000_000,
    cgstPaise: 0,
    sgstPaise: 0,
    igstPaise: 1_800_000,
    cessPaise: 0,
    otherPaise: 0,
    totalPaise: 11_800_000,
  },
  lines: [
    {
      name: 'Steel flask',
      hsn: '732393',
      qtyMicros: 200_000_000,
      uqc: 'NOS',
      taxablePaise: 10_000_000,
      cgstRateBp: 0,
      sgstRateBp: 0,
      igstRateBp: 1800,
      cessRateBp: 0,
    },
  ],
  transport: { mode: 'road', distanceKm: 840, vehicleNo: 'mh 12 ab 1234', vehicleType: 'regular' },
  ...o,
});

describe('the e-way bill', () => {
  it('writes Part A and Part B in the portal layout', () => {
    const j = buildEwb(ewb());
    expect(j).toMatchObject({
      supplyType: 'O',
      subSupplyType: '1',
      docType: 'INV',
      docNo: 'INV/24-25/0042',
      docDate: '01/05/2025',
      fromPincode: 411001,
      fromStateCode: 27,
      toStateCode: 29,
      totalValue: 100000,
      igstValue: 18000,
      totInvValue: 118000,
      transMode: '1',
      transDistance: '840',
      vehicleNo: 'MH12AB1234',
      vehicleType: 'R',
    });
    expect(at(j, 'itemList', 0)).toMatchObject({
      hsnCode: 732393,
      quantity: 200,
      igstRate: 18,
      taxableAmount: 100000,
    });
    expect(checkEwb(ewb())).toEqual([]);
  });

  it('maps document types, and leaves the distance to the portal when it is 0', () => {
    expect(buildEwb(ewb({ docType: 'delivery_challan' }))['docType']).toBe('CHL');
    expect(buildEwb(ewb({ docType: 'bill_of_supply' }))['docType']).toBe('BIL');
    expect(
      buildEwb(ewb({ transport: { ...ewb().transport, distanceKm: 0 } }))['transDistance'],
    ).toBe('0');
  });

  it('needs an e-way bill above INR 50,000, or above the state limit inside some states', () => {
    expect(ewbRequired(50_000 * 100, '27', '29')).toBe(false);
    expect(ewbRequired(50_001 * 100, '27', '29')).toBe(true);
    // Maharashtra's INR 1 lakh is listed but unchecked, so the national limit applies inside it too
    expect(ewbThreshold('27', '27')).toBe(50_000 * 100);
    expect(ewbRequired(80_000 * 100, '27', '27')).toBe(true);
    expect(ewbThreshold('24', '24')).toBe(50_000 * 100);
    // once a state's limit is checked, it counts
    const checked = {
      ...EWB_RULES_V1,
      intraStateThresholds: { '27': { paise: 1_00_000 * 100, checked: true } },
    };
    expect(ewbThreshold('27', '27', checked)).toBe(1_00_000 * 100);
    expect(ewbRequired(80_000 * 100, '27', '27', checked)).toBe(false);
    expect(ewbThreshold('27', '29', checked)).toBe(50_000 * 100);
  });

  it('is valid one day per 200 km (20 km for over-dimensional cargo), each day to midnight of the next day', () => {
    expect(ewbValidUntil('2025-05-01', 100)).toBe('2025-05-02T23:59:59+05:30');
    expect(ewbValidUntil('2025-05-01', 200)).toBe('2025-05-02T23:59:59+05:30');
    expect(ewbValidUntil('2025-05-01', 201)).toBe('2025-05-03T23:59:59+05:30');
    expect(ewbValidUntil('2025-05-01', 840)).toBe('2025-05-06T23:59:59+05:30');
    expect(ewbValidUntil('2025-05-01', 30, 'odc')).toBe('2025-05-03T23:59:59+05:30');
    expect(ewbValidUntil('2025-05-01', 0)).toBe('2025-05-02T23:59:59+05:30');
  });

  it('can be cancelled for 24 hours, and extended from 8 hours before to 8 hours after it expires', () => {
    expect(ewbCancellable('2025-05-01T10:00:00+05:30', new Date('2025-05-02T09:00:00+05:30'))).toBe(
      true,
    );
    expect(ewbCancellable('2025-05-01T10:00:00+05:30', new Date('2025-05-02T11:00:00+05:30'))).toBe(
      false,
    );
    const until = '2025-05-02T23:59:59+05:30';
    expect(ewbExtendable(until, new Date('2025-05-02T12:00:00+05:30'))).toBe(false);
    expect(ewbExtendable(until, new Date('2025-05-02T17:00:00+05:30'))).toBe(true);
    expect(ewbExtendable(until, new Date('2025-05-03T07:00:00+05:30'))).toBe(true);
    expect(ewbExtendable(until, new Date('2025-05-03T09:00:00+05:30'))).toBe(false);
  });

  it('does not need the vehicle for a short movement inside a state to the transporter', () => {
    expect(partBRequired(40, true)).toBe(false);
    expect(partBRequired(60, true)).toBe(true);
    expect(partBRequired(40, false)).toBe(true);
    const local = ewb({
      to: { ...ewb().to, stateCode: '27', pincode: '411014', gstin: BUYER_MH },
      transport: { mode: 'road', distanceKm: 30, vehicleType: 'regular' },
    });
    expect(checkEwb(local)).toEqual([]);
  });

  it('refuses a document older than 180 days from 1 January 2025 (when told the date)', () => {
    const old = ewb({ date: '2025-01-10' });
    expect(checkEwb(old)).toEqual([]);
    expect(checkEwb(old, EWB_RULES_V1, '2025-07-09')).toEqual([]);
    expect(checkEwb(old, EWB_RULES_V1, '2025-07-10').map((p) => p.code)).toEqual(['doc_age']);
    // before the rule started, age did not matter
    expect(checkEwb(ewb({ date: '2024-01-01' }), EWB_RULES_V1, '2024-12-31')).toEqual([]);
    expect(EWB_RULES_V1.docAge).toEqual({
      maxDocAgeDays: 180,
      maxExtensionDays: 360,
      from: '2025-01-01',
    });
  });

  it('catches what the portal would refuse', () => {
    const codes = (e: EwbInput) => checkEwb(e).map((p) => p.code);
    expect(
      codes(ewb({ transport: { mode: 'road', distanceKm: 300, vehicleType: 'regular' } })),
    ).toContain('part_b');
    expect(codes(ewb({ transport: { ...ewb().transport, vehicleNo: '12345' } }))).toContain(
      'vehicle',
    );
    expect(codes(ewb({ transport: { ...ewb().transport, distanceKm: 5000 } }))).toContain(
      'distance',
    );
    expect(
      codes(ewb({ transport: { mode: 'rail', distanceKm: 900, vehicleType: 'regular' } })),
    ).toContain('trans_doc');
    expect(codes(ewb({ to: { ...ewb().to, gstin: 'BAD' } }))).toContain('gstin');
    expect(codes(ewb({ to: { ...ewb().to, gstin: 'URP' } }))).toEqual([]);
    expect(codes(ewb({ lines: [] }))).toContain('no_lines');
    // a transporter ID instead of a vehicle is enough for Part A
    expect(
      codes(
        ewb({
          transport: {
            mode: 'road',
            distanceKm: 300,
            vehicleType: 'regular',
            transporterId: SELLER,
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe('error explanations', () => {
  it('turns a portal code into plain words and the next step, and keeps an unknown code readable', () => {
    expect(explainGspError('2150')).toMatchObject({ retry: false });
    expect(explainGspError('2150').plain).toMatch(/already exists/);
    expect(explainGspError('GD-OFFLINE').retry).toBe(true);
    expect(explainGspError('99999', 'Something odd').plain).toBe('Something odd');
    expect(explainGspError('99999').plain).toMatch(/99999/);
  });
});

describe('the golden payload', () => {
  it('matches the stored file', async () => {
    await expect(`${JSON.stringify(buildEinvoice(doc()), null, 2)}\n`).toMatchFileSnapshot(
      './einvoice/fixtures/b2b-inter-v1_1.golden.json',
    );
  });
});

describe('speed', () => {
  it('builds and checks 1,000 invoices of 10 lines well inside a second', () => {
    const lines = Array.from({ length: 10 }, () => line());
    const d = doc('B2B', {
      lines,
      totals: {
        assessablePaise: lines.reduce((a, l) => a + l.taxablePaise, 0),
        igstPaise: lines.reduce((a, l) => a + l.igstPaise, 0),
        cgstPaise: 0,
        sgstPaise: 0,
        cessPaise: 0,
        discountPaise: 0,
        otherChargesPaise: 0,
        roundOffPaise: 0,
        totalPaise: lines.reduce((a, l) => a + l.totalPaise, 0),
      },
    });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      checkEinvoice(d, ctx);
      buildEinvoice(d);
    }
    const ms = performance.now() - t0;
    console.info(`[perf] 1000 invoices x 10 lines: build and check ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1000);
  });
});

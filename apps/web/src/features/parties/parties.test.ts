import { gstinCheckChar } from '@gst/domain';
import { describe, expect, it } from 'vitest';

import { csvCell, money, partiesCsv, statementCsv, toCsv } from './csv';
import {
  draftToValues,
  emptyPartyDraft,
  normalisePhone,
  parseTags,
  rowToDraft,
  rupeesToPaise,
  validateParty,
  type PartyDraft,
} from './form';

const gstin = (state = '27') => {
  const first14 = `${state}AAPFU0939F1Z`;
  return first14 + gstinCheckChar(first14);
};
const draft = (over: Partial<PartyDraft> = {}): PartyDraft => ({ ...emptyPartyDraft(), ...over });

describe('party validation', () => {
  it('needs a name, and a GSTIN or a state', () => {
    expect(validateParty(draft())).toEqual({ name: 'name', stateCode: 'stateRequired' });
    expect(validateParty(draft({ name: 'Sharma', stateCode: '27' }))).toEqual({});
    expect(validateParty(draft({ name: 'Sharma', gstin: gstin() }))).toEqual({});
    expect(validateParty(draft({ name: 'S', gstin: gstin() }))).toEqual({ name: 'name' });
  });

  it('names what is wrong with a GSTIN', () => {
    expect(validateParty(draft({ name: 'Sharma', gstin: 'abc' }))).toEqual({
      gstin: 'gstin_format',
    });
    const g = gstin();
    expect(
      validateParty(
        draft({ name: 'Sharma', gstin: g.slice(0, 14) + (g.endsWith('A') ? 'B' : 'A') }),
      ),
    ).toEqual({
      gstin: 'gstin_checksum',
    });
  });

  it('does not ask for a state for an export customer', () => {
    expect(validateParty(draft({ name: 'Acme GmbH', country: 'Germany' }))).toEqual({});
    expect(validateParty(draft({ name: 'X', country: '  ' })).country).toBe('country');
  });

  it('validates phone in both modes and the rest only in full mode', () => {
    const base = {
      name: 'Sharma',
      stateCode: '27',
      phone: '12345',
      email: 'nope',
      creditDays: '-3',
    };
    expect(validateParty(draft(base), 'quick')).toEqual({ phone: 'phone' });
    expect(validateParty(draft(base), 'full')).toEqual({
      phone: 'phone',
      email: 'email',
      creditDays: 'creditDays',
    });
  });

  it('validates addresses, contacts, limits and opening balances', () => {
    const e = validateParty(
      draft({
        name: 'Sharma',
        stateCode: '27',
        billing: { line1: 'x', city: 'y', pincode: '4000' },
        shippingSame: false,
        shipping: { line1: 'x', city: 'y', pincode: '40000' },
        contacts: [{ name: 'A', phone: '1', email: 'bad' }],
        creditLimit: '-5',
        opening: '1.234',
        openingDate: '1-1-26',
      }),
    );
    expect(e).toEqual({
      billingPincode: 'pincode',
      shippingPincode: 'pincode',
      contact0Phone: 'phone',
      contact0Email: 'email',
      creditLimit: 'amount',
      opening: 'amount',
      openingDate: 'date',
    });
    // a shipping pincode is ignored while it is the same as billing
    expect(
      validateParty(
        draft({
          name: 'Sharma',
          stateCode: '27',
          shipping: { line1: '', city: '', pincode: 'zz' },
        }),
      ),
    ).toEqual({});
  });

  it('parses rupees and tags', () => {
    expect(rupeesToPaise('')).toBeNull();
    expect(rupeesToPaise('₹1,234.5')).toBe(123_450);
    expect(rupeesToPaise('99')).toBe(9_900);
    expect(rupeesToPaise('1.234')).toBeNaN();
    expect(rupeesToPaise('abc')).toBeNaN();
    expect(parseTags(' vip, wholesale,vip ,, ')).toEqual(['vip', 'wholesale']);
    expect(normalisePhone('+91 98765-43210')).toBe('9876543210');
  });
});

describe('party values', () => {
  it('derives state, PAN and flags from a GSTIN', () => {
    const v = draftToValues(
      draft({
        name: ' Sharma Traders ',
        gstin: gstin('29').toLowerCase(),
        isSez: true,
        isComposition: true,
        phone: '+91 9876543210',
      }),
    );
    expect(v).toMatchObject({
      name: 'Sharma Traders',
      gstin: gstin('29'),
      pan: 'AAPFU0939F',
      state_code: '29',
      phone: '9876543210',
      is_sez: true,
      is_composition: true,
      is_unregistered: false,
      is_export: false,
    });
  });

  it('marks parties without a GSTIN unregistered and ignores SEZ and composition for them', () => {
    const v = draftToValues(
      draft({ name: 'Walk-in', stateCode: '27', isSez: true, isComposition: true }),
    );
    expect(v).toMatchObject({
      gstin: null,
      pan: null,
      state_code: '27',
      is_unregistered: true,
      is_sez: false,
      is_composition: false,
    });
  });

  it('treats a foreign country as an export with state 96', () => {
    expect(draftToValues(draft({ name: 'Acme', country: 'Germany' }))).toMatchObject({
      is_export: true,
      state_code: '96',
      country: 'Germany',
    });
  });

  it('signs the opening balance by who owes whom and keeps it dated only when set', () => {
    const owes = draftToValues(
      draft({ name: 'A', stateCode: '27', opening: '500', openingDate: '2026-04-01' }),
    );
    expect(owes).toMatchObject({
      opening_balance_paise: 50_000,
      opening_balance_date: '2026-04-01',
    });
    const owed = draftToValues(
      draft({
        name: 'A',
        stateCode: '27',
        opening: '500',
        openingSide: 'we-owe',
        openingDate: '2026-04-01',
      }),
    );
    expect(owed['opening_balance_paise']).toBe(-50_000);
    expect(
      draftToValues(draft({ name: 'A', stateCode: '27', openingDate: '2026-04-01' })),
    ).toMatchObject({ opening_balance_paise: 0, opening_balance_date: null });
  });

  it('keeps billing and a separate shipping address, contacts, tags and limits', () => {
    const v = draftToValues(
      draft({
        name: 'A',
        stateCode: '27',
        billing: { line1: ' 1 Road ', city: 'Pune', pincode: '411001' },
        shippingSame: false,
        shipping: { line1: '2 Lane', city: 'Mumbai', pincode: '400001' },
        contacts: [
          { name: 'Raj', phone: '9876543210', email: '' },
          { name: '', phone: '', email: '' },
        ],
        tags: 'vip, wholesale',
        creditDays: '30',
        creditLimit: '50000',
      }),
    );
    expect(v['addresses_json']).toEqual([
      { kind: 'billing', line1: '1 Road', city: 'Pune', pincode: '411001' },
      { kind: 'shipping', line1: '2 Lane', city: 'Mumbai', pincode: '400001' },
    ]);
    expect(v).toMatchObject({
      city: 'Pune',
      credit_days: 30,
      credit_limit_paise: 5_000_000,
      tags_json: ['vip', 'wholesale'],
    });
    expect(v['contacts_json']).toEqual([{ name: 'Raj', phone: '9876543210', email: '' }]);
  });

  it('round-trips through a stored row', () => {
    const original = draft({
      name: 'Round Trip',
      tradeName: 'RT',
      gstin: gstin(),
      billing: { line1: '1 Road', city: 'Pune', pincode: '411001' },
      shippingSame: false,
      shipping: { line1: '2 Lane', city: 'Mumbai', pincode: '400001' },
      contacts: [{ name: 'Raj', phone: '9876543210', email: 'r@x.in' }],
      creditDays: '45',
      creditLimit: '1000.50',
      opening: '250',
      openingSide: 'we-owe',
      openingDate: '2026-04-01',
      notes: 'careful',
      tags: 'vip',
      type: 'both',
    });
    const back = rowToDraft(draftToValues(original));
    expect(back).toMatchObject({
      name: 'Round Trip',
      tradeName: 'RT',
      gstin: gstin(),
      type: 'both',
      creditDays: '45',
      creditLimit: '1000.50',
      opening: '250.00',
      openingSide: 'we-owe',
      openingDate: '2026-04-01',
      notes: 'careful',
      tags: 'vip',
      shippingSame: false,
      shipping: { line1: '2 Lane', city: 'Mumbai', pincode: '400001' },
    });
    expect(back.contacts).toEqual(original.contacts);
  });
});

describe('csv', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('neutralises spreadsheet formulas in text but keeps real negative numbers', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    for (const bad of ['+1+1', '-2', '@SUM(A1)', '\tx', '\rx'])
      expect(csvCell(bad).replace(/^"/, '')).toMatch(/^'/);
    expect(toCsv([[{ numeric: '-12.50' }]])).toBe('\uFEFF-12.50\r\n');
    expect(toCsv([['-12.50']])).toBe("\uFEFF'-12.50\r\n");
  });

  it('writes a statement with a brought-forward line and signed balances', () => {
    const csv = statementCsv({
      openingBalancePaise: 10_000n,
      closingBalancePaise: -5_000n,
      lines: [
        {
          id: '1',
          date: '2026-05-01',
          kind: 'document',
          ref: 'INV-1',
          description: 'tax invoice',
          debitPaise: 20_000n,
          creditPaise: 0n,
          balancePaise: 30_000n,
        },
        {
          id: '2',
          date: '2026-05-02',
          kind: 'payment',
          ref: '',
          description: 'Payment received (upi)',
          debitPaise: 0n,
          creditPaise: 35_000n,
          balancePaise: -5_000n,
        },
      ],
    });
    expect(csv.split('\r\n')).toEqual([
      '\uFEFFDate,Type,Reference,Description,Debit,Credit,Balance',
      ',,,Balance brought forward,,,100.00',
      '2026-05-01,document,INV-1,tax invoice,200.00,,300.00',
      '2026-05-02,payment,,Payment received (upi),,350.00,-50.00',
      '',
    ]);
  });

  it('writes parties with outstanding and overdue', () => {
    const csv = partiesCsv([
      {
        name: 'Sharma, Sons',
        type: 'customer',
        gstin: '',
        phone: '98',
        city: 'Pune',
        state: 'Maharashtra',
        balancePaise: 123_456n,
        overduePaise: 0n,
      },
    ]);
    expect(csv).toContain('"Sharma, Sons",customer,,98,Pune,Maharashtra,1234.56,0.00');
    expect(money(5)).toEqual({ numeric: '0.05' });
  });
});

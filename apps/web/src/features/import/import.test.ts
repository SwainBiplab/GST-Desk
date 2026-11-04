import {
  ItemRepo,
  PartyRepo,
  createOrganisation,
  migrate,
  BusinessRepo,
  type Ctx,
  type Database,
} from '@gst/db';
import { openSqlite } from '@gst/db/node';
import {
  ITEM_FIELDS,
  PARTY_FIELDS,
  detectMapping,
  gstinCheckChar,
  parseCsv,
  withCheckDigit,
} from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reviewItemRows } from '../items/import-items';
import { partyImport, partyDraftFromRow, reviewPartyRows } from '../parties/import-parties';

import type { ImportInput } from './types';

let d: Database;
let ctx: Ctx;

beforeAll(async () => {
  d = await openSqlite();
  await migrate(d);
  const org = await createOrganisation(d, 'Org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev' };
  const biz = await new BusinessRepo(d).create(base, { legal_name: 'Demo', state_code: '27' });
  ctx = { ...base, businessId: biz['id'] };
}, 60_000);
afterAll(async () => {
  await d.close();
});

function input(csv: string, fields: typeof ITEM_FIELDS | typeof PARTY_FIELDS): ImportInput {
  const parsed = parseCsv(csv);
  const [head, ...rows] = parsed.rows;
  const headers = head!.map((h) => h.trim());
  return {
    headers,
    rows,
    lines: parsed.lines.slice(1),
    mapping: detectMapping(headers, fields),
    database: d,
    ctx,
  };
}

const gstin = (state: string) => {
  const first14 = `${state}AAPFU0939F1Z`;
  return first14 + gstinCheckChar(first14);
};

describe('reviewing an item file', () => {
  it('splits good rows from bad ones and numbers the bad ones by file line', async () => {
    const good = withCheckDigit('890123456789');
    const csv = [
      'Item Name,SKU,Barcode,HSN,Unit,Selling Price,GST %',
      `Tea,T-1,${good},0902,NOS,"1,200.50",5`,
      'Sugar,S-1,,1701,NOS,45,5',
      'X,S-2,,1701,NOS,45,5',
      'Salt,S-1,,2501,NOS,20,0',
      'Rice,R-1,4006381333932,1006,NOS,60,0',
      'Oil,O-1,,1507,Tin,100,5',
      '"Spice',
    ].join('\n');
    // the last line is an unterminated quote, so parse the rows before it
    const r = await reviewItemRows(input(csv.split('\n').slice(0, 7).join('\n'), ITEM_FIELDS));
    expect(r.total).toBe(6);
    expect(r.valid.map((v) => v.line)).toEqual([2, 3]);
    expect(r.valid[0]!.values).toMatchObject({
      name: 'Tea',
      sale_rate_paise: 120_050,
      gst_rate_bp: 500,
    });
    const byLine = Object.fromEntries(
      r.invalid.map((i) => [i.line, i.problems.map((p) => p.code)]),
    );
    expect(byLine).toEqual({
      4: ['name'],
      5: ['duplicate_sku'],
      6: ['barcode_checksum'],
      7: ['unit_unknown'],
    });
  });

  it('flags a SKU or barcode that already exists in the business', async () => {
    await new ItemRepo(d).create(ctx, { name: 'Existing', sku: 'EXIST-1' });
    const r = await reviewItemRows(input('Name,SKU\nNew one,EXIST-1\nAnother,NEW-2', ITEM_FIELDS));
    expect(r.invalid.map((i) => i.problems[0]!.code)).toEqual(['duplicate_sku']);
    expect(r.valid).toHaveLength(1);
  });

  it('commits the reviewed rows through the repository', async () => {
    const r = await reviewItemRows(
      input('Name,SKU,HSN,GST\nA item,IMP-A,0902,5\nB item,IMP-B,0902,18', ITEM_FIELDS),
    );
    const created = await new ItemRepo(d).bulkCreate(
      ctx,
      r.valid.map((v) => v.values),
    );
    expect(created.created).toBe(2);
    expect((await new ItemRepo(d).search(ctx, 'IMP-B'))[0]).toMatchObject({
      name: 'B item',
      gst_rate_bp: 1800,
    });
  });
});

describe('party rows', () => {
  const empty = {
    name: 'Sharma',
    trade_name: '',
    type: '',
    gstin: '',
    phone: '',
    email: '',
    address: '',
    city: '',
    state: 'Maharashtra',
    pincode: '',
    credit_days: '',
    opening_balance: '',
    tags: '',
  };

  it('reads the state by name or code, the type by common words and credit days', () => {
    expect(partyDraftFromRow(empty).draft.stateCode).toBe('27');
    expect(partyDraftFromRow({ ...empty, state: '29' }).draft.stateCode).toBe('29');
    expect(partyDraftFromRow({ ...empty, state: 'Narnia' }).problems).toEqual([
      { field: 'state', code: 'state_unknown' },
    ]);
    expect(partyDraftFromRow({ ...empty, type: 'Vendors' }).draft.type).toBe('supplier');
    expect(partyDraftFromRow({ ...empty, type: 'friend' }).problems).toEqual([
      { field: 'type', code: 'party_type' },
    ]);
    expect(partyDraftFromRow({ ...empty, credit_days: '30' }).draft.creditDays).toBe('30');
    expect(partyDraftFromRow({ ...empty, credit_days: 'soon' }).problems).toEqual([
      { field: 'credit_days', code: 'creditDays' },
    ]);
  });

  it('signs the opening balance: negative or bracketed means we owe them', () => {
    const owed = partyDraftFromRow({ ...empty, opening_balance: '(1,500.50)' }).draft;
    expect(owed).toMatchObject({ opening: '1500.50', openingSide: 'we-owe' });
    expect(owed.openingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(partyDraftFromRow({ ...empty, opening_balance: '2000' }).draft).toMatchObject({
      opening: '2000.00',
      openingSide: 'they-owe',
    });
    expect(partyDraftFromRow({ ...empty, opening_balance: 'lots' }).problems).toEqual([
      { field: 'opening_balance', code: 'amount' },
    ]);
  });
});

describe('reviewing and importing a party file', () => {
  it('checks every row, catches GSTIN clashes and posts opening balances', async () => {
    const g = gstin('27');
    const csv = [
      'Name,GSTIN,Phone,State,Opening Balance',
      `Acme Traders,${g},9876543210,Maharashtra,5000`,
      `Acme Again,${g},9876543211,Maharashtra,`,
      'Walk In,,12345,Maharashtra,',
      'Rao Stores,,9876543212,Karnataka,-250',
    ].join('\n');
    const r = await reviewPartyRows(input(csv, PARTY_FIELDS));
    expect(r.valid.map((v) => v.line)).toEqual([2, 5]);
    expect(
      Object.fromEntries(r.invalid.map((i) => [i.line, i.problems.map((p) => p.code)])),
    ).toEqual({
      3: ['duplicate_gstin'],
      4: ['phone'],
    });

    const n = await partyImport.commit({
      values: r.valid.map((v) => v.values),
      database: d,
      ctx,
      onProgress: () => {},
      shouldCancel: () => false,
    });
    expect(n).toBe(2);
    const stored = await new PartyRepo(d).list(ctx);
    expect(stored.find((p) => p['name'] === 'Rao Stores')).toMatchObject({
      opening_balance_paise: -25_000,
      state_code: '29',
    });
    // the same file is now all duplicates by GSTIN
    const again = await reviewPartyRows(input(csv, PARTY_FIELDS));
    expect(again.invalid.find((i) => i.line === 2)!.problems[0]!.code).toBe('duplicate_gstin');
  });
});

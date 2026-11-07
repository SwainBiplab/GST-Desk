import { describe, expect, it } from 'vitest';

import { GspError, MockGspAdapter } from '../src';

const login = { gstin: '27AABCD1234E1Z8', username: 'asha.api' };
const inv = (inum: string) => ({ inum, idt: '05-11-2026', val: 1180, itms: [] });
const file = (nums: string[]) => ({
  gstin: login.gstin,
  fp: '112026',
  b2b: [{ ctin: '29AAACB1234F1Z5', inv: nums.map(inv) }],
  b2cs: [{ pos: '27', rt: 18 }],
});
async function session(g = new MockGspAdapter()) {
  const c = await g.requestGstnOtp(login);
  return { g, s: await g.verifyGstnOtp(login, c.txnId, '123456') };
}

describe('the return portal login', () => {
  it('logs in with the OTP the taxpayer types, and refuses a wrong or expired one', async () => {
    const g = new MockGspAdapter();
    const c = await g.requestGstnOtp(login);
    await expect(g.verifyGstnOtp(login, c.txnId, '000000')).rejects.toMatchObject({
      code: 'AUTH4033',
    });
    const s = await g.verifyGstnOtp(login, c.txnId, '123456');
    expect(s).toMatchObject({ portal: 'gstn', gstin: login.gstin });
    expect(s.expiresAt).toBeGreaterThan(Date.now());
    // an OTP is used once
    await expect(g.verifyGstnOtp(login, c.txnId, '123456')).rejects.toBeInstanceOf(GspError);
    let t = Date.now();
    const late = new MockGspAdapter({ now: () => new Date(t) });
    const c2 = await late.requestGstnOtp(login);
    t += 11 * 60_000;
    await expect(late.verifyGstnOtp(login, c2.txnId, '123456')).rejects.toMatchObject({
      code: 'AUTH4034',
    });
  });
  it('a session runs out', async () => {
    const { g, s } = await session();
    g.expireTokens();
    await expect(g.pullGstr2b(s, '112026')).rejects.toMatchObject({ code: 'GD-AUTH' });
  });
});

describe('pushing a return', () => {
  it('saves every table and reports what each took', async () => {
    const { g, s } = await session();
    const r = await g.pushGstr1(s, '112026', file(['INV/1', 'INV/2']));
    expect(r.tables).toEqual([
      { table: 'b2b', status: 'ok', count: 2, errors: [] },
      { table: 'b2cs', status: 'ok', count: 1, errors: [] },
    ]);
    expect((await g.getPushStatus(s, '112026', r.reference)).state).toBe('processed');
  });
  it('the same file again is the same upload; a changed one is a new reference', async () => {
    const { g, s } = await session();
    const a = await g.pushGstr1(s, '112026', file(['INV/1']));
    expect((await g.pushGstr1(s, '112026', file(['INV/1']))).reference).toBe(a.reference);
    expect((await g.pushGstr1(s, '112026', file(['INV/1', 'INV/2']))).reference).not.toBe(
      a.reference,
    );
  });
  it('a partial failure names the invoices the portal refused, per table', async () => {
    const { g, s } = await session(new MockGspAdapter({ rejectNumbers: ['INV/2'] }));
    const r = await g.pushGstr1(s, '112026', file(['INV/1', 'INV/2']));
    expect(r.tables[0]).toMatchObject({ table: 'b2b', status: 'error', count: 1 });
    expect(r.tables[0]!.errors[0]).toMatchObject({ code: 'RET13504', ref: 'INV/2' });
    expect(r.tables[1]).toMatchObject({ table: 'b2cs', status: 'ok' });
    expect((await g.getPushStatus(s, '112026', r.reference)).state).toBe('error');
  });
  it('is processed after a few asks when the portal is slow', async () => {
    const { g, s } = await session(new MockGspAdapter({ pollsToProcess: 2 }));
    const r = await g.pushGstr1(s, '112026', file(['INV/1']));
    expect((await g.getPushStatus(s, '112026', r.reference)).state).toBe('processing');
    expect((await g.getPushStatus(s, '112026', r.reference)).state).toBe('processing');
    expect((await g.getPushStatus(s, '112026', r.reference)).state).toBe('processed');
  });
  it('refuses a file for another GSTIN or period, and takes a nil return', async () => {
    const { g, s } = await session();
    await expect(
      g.pushGstr1(s, '112026', { ...file(['INV/1']), gstin: '29AAACB1234F1Z5' }),
    ).rejects.toMatchObject({ code: 'RET191106' });
    await expect(g.pushGstr1(s, '122026', file(['INV/1']))).rejects.toMatchObject({
      code: 'RET191107',
    });
    const nil = await g.pushGstr1(
      s,
      '112026',
      { gstin: login.gstin, fp: '112026', nil_return: true },
      { nil: true },
    );
    expect(nil.tables).toEqual([{ table: 'nil', status: 'ok', count: 0, errors: [] }]);
  });
});

describe('pulling and filing state', () => {
  it('pulls 2B once the portal has made it, and says when it has not', async () => {
    const { g, s } = await session();
    await expect(g.pullGstr2b(s, '112026')).rejects.toMatchObject({ code: 'RTN00024' });
    g.setGstr2b('112026', { data: { gstin: login.gstin, rtnprd: '112026', docdata: {} } });
    expect((await g.pullGstr2b(s, '112026'))['data']).toMatchObject({ rtnprd: '112026' });
  });
  it('reports a return the taxpayer filed on the portal with its ARN', async () => {
    const { g, s } = await session();
    expect(await g.getFilingState(s, '112026', 'gstr1')).toEqual({
      filed: false,
      arn: null,
      filedOn: null,
    });
    g.setFiled(login.gstin, '112026', 'gstr1', 'AA270000000001A', '2026-12-10');
    expect(await g.getFilingState(s, '112026', 'gstr1')).toEqual({
      filed: true,
      arn: 'AA270000000001A',
      filedOn: '2026-12-10',
    });
  });
  it('counts every call to the return portal, for metering', async () => {
    const { g, s } = await session();
    await g.pushGstr1(s, '112026', file(['INV/1']));
    expect(g.gstnCalls).toEqual(['otp', 'verify', 'push']);
  });
});

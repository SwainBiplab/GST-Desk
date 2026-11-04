import { gstinCheckChar } from '@gst/domain';
import { describe, expect, it } from 'vitest';

import {
  checklistVisible,
  computeChecklist,
  doneIds,
  isProfileComplete,
  type Dismissed,
} from './checklist';
import {
  draftToValues,
  emptyDraft,
  normalisePhone,
  readSettings,
  rowToDraft,
  validateBank,
  validateDetails,
  validateRegistration,
  type BusinessDraft,
} from './profile';

const gstin = (() => {
  const first14 = '27AAPFU0939F1Z';
  return first14 + gstinCheckChar(first14);
})();

const draft = (over: Partial<BusinessDraft> = {}): BusinessDraft => ({ ...emptyDraft(), ...over });

describe('registration step', () => {
  it('requires a GSTIN unless the business is not registered', () => {
    expect(validateRegistration(draft())).toEqual({ gstin: 'gstinRequired' });
    expect(validateRegistration(draft({ gstin }))).toEqual({});
    expect(validateRegistration(draft({ gstin: gstin.toLowerCase() }))).toEqual({});
  });

  it('names the reason a GSTIN is wrong', () => {
    expect(validateRegistration(draft({ gstin: 'ABC' }))).toEqual({ gstin: 'gstin_format' });
    expect(
      validateRegistration(
        draft({ gstin: gstin.slice(0, 14) + (gstin.endsWith('A') ? 'B' : 'A') }),
      ),
    ).toEqual({
      gstin: 'gstin_checksum',
    });
    const badState = '25AAPFU0939F1Z';
    expect(validateRegistration(draft({ gstin: badState + gstinCheckChar(badState) }))).toEqual({
      gstin: 'gstin_state',
    });
  });

  it('asks for a state when not registered', () => {
    expect(validateRegistration(draft({ notRegistered: true }))).toEqual({
      stateCode: 'stateRequired',
    });
    expect(validateRegistration(draft({ notRegistered: true, stateCode: '99x' }))).toEqual({
      stateCode: 'stateRequired',
    });
    expect(validateRegistration(draft({ notRegistered: true, stateCode: '29' }))).toEqual({});
  });
});

describe('details step', () => {
  it('requires a name and an address line', () => {
    expect(validateDetails(draft())).toEqual({
      legalName: 'nameRequired',
      line1: 'addressRequired',
    });
    expect(validateDetails(draft({ legalName: 'A', line1: 'x' }))).toEqual({
      legalName: 'nameRequired',
    });
    expect(validateDetails(draft({ legalName: 'Demo Traders', line1: '12 Market Road' }))).toEqual(
      {},
    );
  });

  it('validates optional pincode, phone and email only when given', () => {
    const ok = { legalName: 'Demo', line1: 'x' };
    expect(validateDetails(draft({ ...ok, pincode: '40001' }))).toEqual({ pincode: 'pincode' });
    expect(validateDetails(draft({ ...ok, pincode: '400001', phone: '12345' }))).toEqual({
      phone: 'phone',
    });
    expect(validateDetails(draft({ ...ok, phone: '+91 98765 43210', email: 'a@b.in' }))).toEqual(
      {},
    );
    expect(validateDetails(draft({ ...ok, email: 'not-an-email' }))).toEqual({ email: 'email' });
  });

  it('normalises Indian phone formats', () => {
    expect(normalisePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalisePhone('09876543210')).toBe('9876543210');
    expect(normalisePhone('(98765) 43210')).toBe('9876543210');
  });
});

describe('bank step', () => {
  const bank = {
    enabled: true,
    kind: 'bank' as const,
    name: 'HDFC',
    accountNo: '123456789012',
    ifsc: 'hdfc0001234',
    upiId: '',
  };
  it('is optional', () =>
    expect(validateBank({ ...bank, enabled: false, accountNo: '' })).toEqual({}));
  it('checks account number and IFSC', () => {
    expect(validateBank(bank)).toEqual({});
    expect(validateBank({ ...bank, accountNo: '123' })).toEqual({ accountNo: 'accountNo' });
    expect(validateBank({ ...bank, ifsc: 'HDFC1001234' })).toEqual({ ifsc: 'ifsc' });
    expect(validateBank({ ...bank, name: '' })).toEqual({ bankName: 'bankName' });
  });
  it('checks UPI ids', () => {
    const upi = { ...bank, kind: 'upi' as const };
    expect(validateBank({ ...upi, upiId: 'shop@okhdfc' })).toEqual({});
    expect(validateBank({ ...upi, upiId: 'shop' })).toEqual({ upiId: 'upi' });
  });
});

describe('draft <-> row', () => {
  it('derives state and PAN from the GSTIN and sets composition only when registered', () => {
    const v = draftToValues(
      draft({
        gstin,
        legalName: ' Demo ',
        line1: ' 1 Road ',
        composition: true,
        preset: 'retail',
        phone: '+91 9876543210',
      }),
    );
    expect(v).toMatchObject({
      gstin,
      legal_name: 'Demo',
      state_code: '27',
      pan: 'AAPFU0939F',
      scheme: 'composition',
      preset: 'retail',
      fy_start_month: 4,
      address: { line1: '1 Road', stateCode: '27' },
    });
    expect(v['settings_json']).toMatchObject({
      contact: { phone: '9876543210' },
      printTemplate: 'thermal-80',
    });
    const unreg = draftToValues(
      draft({
        notRegistered: true,
        stateCode: '29',
        composition: true,
        legalName: 'X',
        line1: 'y',
      }),
    );
    expect(unreg).toMatchObject({ gstin: null, pan: null, scheme: 'regular', state_code: '29' });
    expect(unreg['settings_json']).toMatchObject({ notRegisteredYet: true });
  });

  it('round-trips through a stored row without putting images in it', () => {
    const d = draft({
      gstin,
      legalName: 'Demo',
      tradeName: 'D',
      line1: '1 Road',
      city: 'Pune',
      pincode: '411001',
      email: 'a@b.in',
      preset: 'services',
    });
    const row = { ...draftToValues(d) };
    const back = rowToDraft(row);
    expect(back).toMatchObject({
      gstin,
      legalName: 'Demo',
      tradeName: 'D',
      line1: '1 Road',
      city: 'Pune',
      pincode: '411001',
      email: 'a@b.in',
      preset: 'services',
      composition: false,
    });
    expect(JSON.stringify(row)).not.toMatch(/data:image|base64/);
  });

  it('reads missing settings as empty', () => {
    expect(readSettings(null)).toEqual({});
    expect(readSettings({ settings_json: null })).toEqual({});
  });
});

describe('getting-started checklist', () => {
  const complete = {
    ...draftToValues(draft({ gstin, legalName: 'Demo', line1: '1 Road' })),
  };
  it('detects a complete profile', () => {
    expect(isProfileComplete(complete)).toBe(true);
    expect(isProfileComplete(null)).toBe(false);
    expect(isProfileComplete({ ...complete, gstin: null, settings_json: {} })).toBe(false);
    expect(
      isProfileComplete({ ...complete, gstin: null, settings_json: { notRegisteredYet: true } }),
    ).toBe(true);
    expect(isProfileComplete({ ...complete, address: { stateCode: '27' } })).toBe(false);
    expect(isProfileComplete({ ...complete, legal_name: ' ' })).toBe(false);
    expect(isProfileComplete({ ...complete, gstin: 'bogus' })).toBe(false);
  });

  it('ticks steps from the data', () => {
    const steps = computeChecklist({
      business: { ...complete, settings_json: { logoAttachmentId: 'a1' } },
      facts: { parties: 3, items: 0, issuedSales: 1, payments: 0 },
      backupFolderSet: true,
    });
    expect(Object.fromEntries(steps.map((s) => [s.id, s.done]))).toEqual({
      profile: true,
      logo: true,
      party: true,
      item: false,
      invoice: true,
      payment: false,
      backup: true,
    });
    expect(steps.find((s) => s.id === 'item')).toMatchObject({
      page: 'items',
      search: { new: '1' },
    });
  });

  const stepsWith = (done: string[]) =>
    computeChecklist({
      business: done.includes('profile') ? complete : null,
      facts: {
        parties: done.includes('party') ? 1 : 0,
        items: done.includes('item') ? 1 : 0,
        issuedSales: 0,
        payments: 0,
      },
      backupFolderSet: false,
    });

  it('shows while anything is left and hides when everything is done', () => {
    expect(checklistVisible(stepsWith([]), null)).toBe(true);
    const all = computeChecklist({
      business: { ...complete, settings_json: { logoAttachmentId: 'a' } },
      facts: { parties: 1, items: 1, issuedSales: 1, payments: 1 },
      backupFolderSet: true,
    });
    expect(checklistVisible(all, null)).toBe(false);
  });

  it('stays hidden after dismissal until a finished step regresses', () => {
    const before = stepsWith(['profile', 'party']);
    const dismissed: Dismissed = { done: doneIds(before) };
    expect(dismissed.done).toEqual(['profile', 'party']);
    expect(checklistVisible(before, dismissed)).toBe(false);
    // finishing more steps does not bring it back
    expect(checklistVisible(stepsWith(['profile', 'party', 'item']), dismissed)).toBe(false);
    // the party step regresses (e.g. the only party was archived): it returns
    expect(checklistVisible(stepsWith(['profile']), dismissed)).toBe(true);
    // profile regresses
    expect(checklistVisible(stepsWith(['party']), dismissed)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { redact, verhoeffAppend, verhoeffValid } from '../src';

const VALID_AADHAAR = verhoeffAppend('23456789012'); // 12 digits, valid checksum
const BAD_AADHAAR = VALID_AADHAAR.slice(0, 11) + String((Number(VALID_AADHAAR[11]) + 1) % 10);

describe('Verhoeff', () => {
  it('generates and validates check digits', () => {
    expect(verhoeffValid(VALID_AADHAAR)).toBe(true);
    expect(verhoeffValid(BAD_AADHAAR)).toBe(false);
    expect(verhoeffValid('2363')).toBe(true); // classic example 236 + check digit 3
    expect(verhoeffValid('abc')).toBe(false);
  });
});

describe('redact', () => {
  it('masks PAN and restores it', () => {
    const r = redact('Supplier PAN AAPFU0939F, GSTIN 27AAPFU0939F1ZV');
    expect(r.text).toContain('[PAN_1]');
    expect(r.text).not.toContain('AAPFU0939F,');
    expect(r.counts.PAN).toBe(1);
    expect(r.restore(`confirmed ${'[PAN_1]'}`)).toBe('confirmed AAPFU0939F');
  });

  it('masks account numbers only near account context', () => {
    const near = redact('Pay to A/c No. 123456789012345 IFSC HDFC0001234');
    expect(near.text).toContain('[ACCOUNT_1]');
    expect(near.counts.ACCOUNT).toBe(1);
    const far = redact('Invoice total 1234567890123 units shipped');
    expect(far.text).toBe('Invoice total 1234567890123 units shipped');
    const byIfsc = redact('SBIN0000123 987654321098');
    expect(byIfsc.counts.ACCOUNT).toBe(1);
    expect(redact('a/c 12345678').counts.ACCOUNT).toBe(0); // 8 digits is too short
  });

  it('masks Aadhaar only when the checksum is valid', () => {
    const ok = redact(`Aadhaar ${VALID_AADHAAR}`);
    expect(ok.counts.AADHAAR).toBe(1);
    expect(ok.text).toBe('Aadhaar [AADHAAR_1]');
    const grouped = `${VALID_AADHAAR.slice(0, 4)} ${VALID_AADHAAR.slice(4, 8)} ${VALID_AADHAAR.slice(8)}`;
    expect(redact(`UID ${grouped}`).counts.AADHAAR).toBe(1);
    const bad = redact(`Aadhaar ${BAD_AADHAAR}`);
    expect(bad.counts.AADHAAR).toBe(0);
    expect(bad.text).toContain(BAD_AADHAAR);
    // Aadhaar numbers never start with 0 or 1
    expect(redact('Aadhaar 123456789012').counts.AADHAAR).toBe(0);
  });

  it('masks phones only when asked', () => {
    const text = 'Call +91 9876543210 or 09123456789';
    expect(redact(text).counts.PHONE).toBe(0);
    const r = redact(text, { phones: true });
    expect(r.counts.PHONE).toBe(2);
    expect(r.text).toBe('Call [PHONE_1] or [PHONE_2]');
    expect(r.restore(r.text)).toBe(text);
  });

  it('numbers repeated values separately and round-trips mixed text', () => {
    const original = `PAN AAPFU0939F and ABCDE1234F, a/c 123456789012, Aadhaar ${VALID_AADHAAR}`;
    const r = redact(original);
    expect(r.counts).toEqual({ PAN: 2, ACCOUNT: 1, AADHAAR: 1, PHONE: 0 });
    expect(r.text).not.toMatch(/AAPFU|ABCDE|123456789012/);
    expect(r.restore(r.text)).toBe(original);
  });

  it('leaves unknown placeholders alone when restoring', () => {
    expect(redact('nothing here').restore('[PAN_9] stays')).toBe('[PAN_9] stays');
  });

  it('keeps context checks aligned after earlier replacements', () => {
    const r = redact('PAN AAPFU0939F then a/c 123456789012');
    expect(r.counts.ACCOUNT).toBe(1);
  });
});

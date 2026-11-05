import { describe, expect, it } from 'vitest';

import {
  FEATURES,
  afterSend,
  clean,
  emptyState,
  isFeature,
  payload,
  record,
  sendDue,
} from './core';

const WEEK = 7 * 24 * 3_600_000;
const fresh = () => emptyState(() => 'install-id-0001');

describe('usage counters', () => {
  it('count only features on the list', () => {
    let s = fresh();
    s = record(s, 'invoice_issued');
    s = record(s, 'invoice_issued');
    s = record(s, 'report_opened');
    s = record(s, 'a party called Sharma Traders'); // content is never counted
    s = record(s, 'GSTIN 27AAPFU0939F1ZV');
    s = record(s, 42);
    s = record(s, undefined);
    expect(s.counts).toEqual({ invoice_issued: 2, report_opened: 1 });
  });

  it('cannot name anything that is not a feature, however it is built', () => {
    for (const f of FEATURES) expect(isFeature(f)).toBe(true);
    for (const bad of ['', 'invoice', '__proto__', 'constructor', 'toString', null, {}, 1])
      expect(isFeature(bad), String(bad)).toBe(false);
  });

  it('a stored or edited value is cleaned down to well-formed counts of known features', () => {
    expect(
      clean({
        invoice_issued: 3,
        report_opened: -1,
        backup_made: 1.5,
        pdf_saved: 'many',
        help_opened: 1e12,
        'Sharma Traders': 9,
        item_added: 2,
      }),
    ).toEqual({ invoice_issued: 3, item_added: 2 });
    expect(clean(null)).toEqual({});
    expect(clean('x')).toEqual({});
  });

  it('what is sent is the version, the platform, a random id and the counts, and nothing more', () => {
    const s = record(fresh(), 'payment_recorded');
    const p = payload(s, '0.1.0-beta.1', 'desktop');
    expect(p).toEqual({
      v: 1,
      installId: 'install-id-0001',
      appVersion: '0.1.0-beta.1',
      platform: 'desktop',
      counts: { payment_recorded: 1 },
    });
    expect(Object.keys(p).sort()).toEqual(['appVersion', 'counts', 'installId', 'platform', 'v']);
  });

  it('is sent at most weekly and only when there is something to send', () => {
    const empty = fresh();
    expect(sendDue(empty, 1_000)).toBe(false);
    const s = record(empty, 'app_opened');
    expect(sendDue(s, 1_000)).toBe(true);
    const sent = afterSend(s, 5_000);
    expect(sent.counts).toEqual({});
    expect(sent.installId).toBe(s.installId);
    expect(sendDue(record(sent, 'app_opened'), 5_000 + WEEK - 1)).toBe(false);
    expect(sendDue(record(sent, 'app_opened'), 5_000 + WEEK)).toBe(true);
  });
});

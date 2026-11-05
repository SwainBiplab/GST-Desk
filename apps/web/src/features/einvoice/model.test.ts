import type { Row } from '@gst/db';
import { describe, expect, it } from 'vitest';

import {
  canCancelEwb,
  canCancelIrn,
  canExtendEwb,
  ewbView,
  hoursLeft,
  irnState,
  istText,
  latestJob,
  pendingOrFailed,
} from './model';

const job = (kind: string, status: string, extra: Row = {}): Row =>
  ({ kind, status, last_code: null, last_message: null, ...extra }) as Row;
const IST = (s: string) => new Date(`${s}+05:30`);

describe('where a document stands with its IRN', () => {
  it('a recorded IRN wins over any request', () => {
    const einv = { status: 'active', ack_date: '2026-04-03 10:00:00' } as Row;
    expect(irnState(einv, [job('irn', 'failed')]).kind).toBe('active');
    expect(irnState({ ...einv, status: 'cancelled' } as Row, []).kind).toBe('cancelled');
  });

  it('shows a request on its way, and a failed one with the plain reason and the next step', () => {
    expect(irnState(null, [job('irn', 'queued')]).kind).toBe('queued');
    const s = irnState(null, [job('irn', 'failed', { last_code: '2150' })]);
    expect(s.kind).toBe('failed');
    if (s.kind === 'failed') {
      expect(s.plain.length).toBeGreaterThan(10);
      expect(s.next.length).toBeGreaterThan(5);
    }
    expect(irnState(null, [])).toEqual({ kind: 'none' });
  });

  it('uses the newest request of the kind asked for', () => {
    const jobs = [job('irn_cancel', 'queued'), job('irn', 'done'), job('irn', 'failed')];
    expect(latestJob(jobs, ['irn'])?.['status']).toBe('done');
    expect(pendingOrFailed(jobs, ['irn_cancel']).pending).not.toBeNull();
    expect(pendingOrFailed(jobs, ['ewb'])).toEqual({ pending: null, failed: null });
  });

  it('a request that failed for a code we do not know still gets a sentence', () => {
    const f = pendingOrFailed([job('ewb', 'failed', { last_code: '99999' })], ['ewb']).failed;
    expect(f?.plain.length).toBeGreaterThan(10);
  });
});

describe('the 24-hour and 8-hour windows', () => {
  const einv = { status: 'active', ack_date: '2026-04-03 10:00:00' } as Row;
  it('an IRN can be cancelled for 24 hours', () => {
    expect(canCancelIrn(einv, IST('2026-04-04T09:59:00'))).toBe(true);
    expect(canCancelIrn(einv, IST('2026-04-04T10:01:00'))).toBe(false);
    expect(canCancelIrn({ ...einv, status: 'cancelled' } as Row, IST('2026-04-03T11:00:00'))).toBe(
      false,
    );
  });

  const w = {
    status: 'active',
    generated_at: '2026-04-03T10:00:00+05:30',
    valid_until: '2026-04-04T23:59:59+05:30',
  } as Row;
  it('an e-way bill is extended from 8 hours before to 8 hours after its end', () => {
    expect(canExtendEwb(w, IST('2026-04-04T10:00:00'))).toBe(false);
    expect(canExtendEwb(w, IST('2026-04-04T16:30:00'))).toBe(true);
    expect(canExtendEwb(w, IST('2026-04-05T07:00:00'))).toBe(true);
    expect(canExtendEwb(w, IST('2026-04-05T09:00:00'))).toBe(false);
  });
  it('an e-way bill is cancelled within 24 hours of being made', () => {
    expect(canCancelEwb(w, IST('2026-04-04T09:00:00'))).toBe(true);
    expect(canCancelEwb(w, IST('2026-04-04T11:00:00'))).toBe(false);
  });
});

describe('the countdown', () => {
  const until = '2026-04-04T23:59:59+05:30';
  it('counts whole hours and stops at expiry', () => {
    expect(hoursLeft(until, IST('2026-04-04T20:00:00'))).toBe(3);
    expect(hoursLeft(until, IST('2026-04-04T23:00:00'))).toBe(0);
    expect(hoursLeft(until, IST('2026-04-05T00:00:01'))).toBeNull();
    expect(hoursLeft('not a date', new Date())).toBeNull();
  });
  it('tells active, expired and cancelled apart', () => {
    const w = { status: 'active', valid_until: until } as Row;
    expect(ewbView(w, IST('2026-04-04T12:00:00'))).toBe('active');
    expect(ewbView(w, IST('2026-04-05T12:00:00'))).toBe('expired');
    expect(ewbView({ ...w, status: 'cancelled' } as Row, IST('2026-04-04T12:00:00'))).toBe(
      'cancelled',
    );
  });
  it('writes the portal time the way a person reads it', () => {
    expect(istText(until)).toBe('04/04/2026 23:59');
    expect(istText('2026-04-03 10:00:00')).toBe('03/04/2026 10:00');
    expect(istText('odd')).toBe('odd');
  });
});

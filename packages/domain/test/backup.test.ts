import { describe, expect, it } from 'vitest';

import {
  downloadReminderDue,
  isBackupDue,
  isClockTime,
  isTrashExpired,
  istDay,
  retentionPlan,
  trashDaysLeft,
  trashPurgeAt,
} from '../src';

const IST = 330 * 60_000;
const DAY = 86_400_000;
/** An instant from an Indian date and time. */
const at = (date: string, time = '12:00') => Date.parse(`${date}T${time}:00Z`) - IST;

describe('when an automatic backup is due', () => {
  const off = { enabled: false, time: '02:00' };
  it('never, when switched off', () => {
    expect(isBackupDue(null, at('2025-03-01'), off)).toBe(false);
  });

  it('on the first launch of the day, when no time is set', () => {
    const s = { enabled: true, time: null };
    expect(isBackupDue(null, at('2025-03-01', '09:00'), s)).toBe(true);
    expect(isBackupDue(at('2025-02-28', '23:50'), at('2025-03-01', '00:10'), s)).toBe(true);
    expect(isBackupDue(at('2025-03-01', '00:05'), at('2025-03-01', '23:00'), s)).toBe(false);
  });

  it('at the set time, or at the first launch after it', () => {
    const s = { enabled: true, time: '14:30' };
    // before the time today: not yet, even though yesterday's was a day ago
    expect(isBackupDue(at('2025-02-28', '14:31'), at('2025-03-01', '14:29'), s)).toBe(false);
    expect(isBackupDue(at('2025-02-28', '14:31'), at('2025-03-01', '14:30'), s)).toBe(true);
    // the app was closed at 14:30; the next launch takes it
    expect(isBackupDue(at('2025-02-28', '14:31'), at('2025-03-01', '18:00'), s)).toBe(true);
    // done once today
    expect(isBackupDue(at('2025-03-01', '14:40'), at('2025-03-01', '18:00'), s)).toBe(false);
    // a manual backup before the time does not count for the scheduled one
    expect(isBackupDue(at('2025-03-01', '09:00'), at('2025-03-01', '15:00'), s)).toBe(true);
    expect(isBackupDue(null, at('2025-03-01', '03:00'), s)).toBe(false);
  });

  it('counts the day in Indian time, not UTC', () => {
    // 00:30 IST on 2 March is 19:00 UTC on 1 March
    const s = { enabled: true, time: null };
    const lateYesterdayIst = at('2025-03-01', '23:50');
    expect(istDay(at('2025-03-02', '00:30'))).toBe('2025-03-02');
    expect(isBackupDue(lateYesterdayIst, at('2025-03-02', '00:30'), s)).toBe(true);
  });

  it('recognises a clock time', () => {
    expect(['00:00', '02:30', '23:59'].every(isClockTime)).toBe(true);
    expect(['24:00', '2:30', '12:60', 'noon', ''].some(isClockTime)).toBe(false);
  });
});

describe('which backups to keep', () => {
  const files = (days: number[], hour = '03:00') =>
    days.map((back) => {
      const ms = at('2025-06-30', hour) - back * DAY;
      return { name: `b-${back}`, at: ms };
    });

  it('keeps one a day for 30 days and one a month for 12 months', () => {
    // a backup every day for 400 days
    const all = files(Array.from({ length: 400 }, (_, i) => i));
    const { keep, remove } = retentionPlan(all, at('2025-06-30', '10:00'));
    expect(keep.length + remove.length).toBe(400);
    const kept = new Set(keep);
    for (let back = 0; back < 30; back++) expect(kept.has(`b-${back}`), `day ${back}`).toBe(true);
    // beyond 30 days only the newest of each of the 12 months survives
    const olderKept = keep.filter((n) => Number(n.slice(2)) >= 30);
    const months = new Set(
      olderKept.map((n) => new Date(all[Number(n.slice(2))]!.at + IST).toISOString().slice(0, 7)),
    );
    expect(months.size).toBe(olderKept.length);
    expect(keep.length).toBeLessThanOrEqual(30 + 12);
    expect(kept.has('b-399')).toBe(false);
  });

  it('leaves one backup for a day that has several, the newest', () => {
    const now = at('2025-06-30', '23:00');
    const day = [
      { name: 'morning', at: at('2025-06-30', '08:00') },
      { name: 'noon', at: at('2025-06-30', '12:00') },
      { name: 'evening', at: at('2025-06-30', '20:00') },
    ];
    const { keep, remove } = retentionPlan(day, now);
    expect(keep).toEqual(['evening']);
    expect(remove.sort()).toEqual(['morning', 'noon']);
  });

  it('always keeps the newest, and never plans to remove the only backup', () => {
    expect(retentionPlan([{ name: 'only', at: at('2020-01-01') }], at('2025-06-30')).keep).toEqual([
      'only',
    ]);
    expect(retentionPlan([], at('2025-06-30'))).toEqual({ keep: [], remove: [] });
  });

  it('keeps a single recent backup per month for the older months, newest of the month', () => {
    const now = at('2025-06-30');
    const old = [
      { name: 'jan-early', at: at('2025-01-03') },
      { name: 'jan-late', at: at('2025-01-28') },
      { name: 'dec', at: at('2024-12-15') },
      { name: 'ancient', at: at('2023-05-10') },
    ];
    const { keep, remove } = retentionPlan(old, now);
    expect(keep.sort()).toEqual(['dec', 'jan-late']);
    expect(remove.sort()).toEqual(['ancient', 'jan-early']);
  });

  it('respects a different policy', () => {
    const all = files(Array.from({ length: 10 }, (_, i) => i));
    expect(retentionPlan(all, at('2025-06-30', '10:00'), { daily: 3, monthly: 0 }).keep).toEqual([
      'b-0',
      'b-1',
      'b-2',
    ]);
  });
});

describe('download reminders for the browser', () => {
  const now = at('2025-06-30');
  it('after seven days without a download, counted from the later of the last one and the install', () => {
    expect(downloadReminderDue(null, now - 3 * DAY, now)).toBe(false);
    expect(downloadReminderDue(null, now - 7 * DAY, now)).toBe(true);
    expect(downloadReminderDue(now - 2 * DAY, now - 90 * DAY, now)).toBe(false);
    expect(downloadReminderDue(now - 8 * DAY, now - 90 * DAY, now)).toBe(true);
    // a download older than the data on the device does not count
    expect(downloadReminderDue(now - 30 * DAY, now - 1 * DAY, now)).toBe(false);
  });
});

describe('the trash', () => {
  const deleted = at('2025-06-01');
  it('holds things for 30 days', () => {
    expect(trashPurgeAt(deleted)).toBe(deleted + 30 * DAY);
    expect(isTrashExpired(deleted, deleted + 30 * DAY - 1)).toBe(false);
    expect(isTrashExpired(deleted, deleted + 30 * DAY)).toBe(true);
  });
  it('counts the whole days left, never below zero', () => {
    expect(trashDaysLeft(deleted, deleted)).toBe(30);
    expect(trashDaysLeft(deleted, deleted + 29 * DAY + 1)).toBe(1);
    expect(trashDaysLeft(deleted, deleted + 99 * DAY)).toBe(0);
  });
});

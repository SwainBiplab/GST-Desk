/**
 * The rules around backups that need no database: when one is due, which old ones to keep, when to
 * remind someone who can only download, and how long the trash holds things. Times are epoch
 * milliseconds; days are Indian days (UTC+05:30), like everything else in the app.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
const IST = 330 * MINUTE;

/** The Indian calendar day of an instant, as `YYYY-MM-DD`. */
export const istDay = (ms: number): string => new Date(ms + IST).toISOString().slice(0, 10);
/** The Indian calendar month of an instant, as `YYYY-MM`. */
export const istMonth = (ms: number): string => istDay(ms).slice(0, 7);

/** Midnight at the start of an Indian day, as an instant. */
const startOfIstDay = (ms: number): number => Math.floor((ms + IST) / DAY) * DAY - IST;

export interface BackupSchedule {
  /** Back up automatically. */
  enabled: boolean;
  /** `HH:MM` in Indian time, or null for "the first time the app opens each day". */
  time: string | null;
}

export const DEFAULT_SCHEDULE: BackupSchedule = { enabled: true, time: null };

export const isClockTime = (v: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/**
 * Whether an automatic backup should be taken now. With a time, it is due once that time has passed
 * today and nothing was backed up since; the app not running at that moment just means it happens at
 * the next launch. Without a time, it is due on the first launch of each day.
 */
export function isBackupDue(
  lastBackupAt: number | null,
  nowMs: number,
  schedule: BackupSchedule = DEFAULT_SCHEDULE,
): boolean {
  if (!schedule.enabled) return false;
  const dayStart = startOfIstDay(nowMs);
  if (!schedule.time || !isClockTime(schedule.time))
    return lastBackupAt === null || lastBackupAt < dayStart;
  const [h, m] = schedule.time.split(':').map(Number) as [number, number];
  const scheduled = dayStart + h * 60 * MINUTE + m * MINUTE;
  return nowMs >= scheduled && (lastBackupAt === null || lastBackupAt < scheduled);
}

export interface BackupFileInfo {
  name: string;
  /** When it was made. */
  at: number;
}

export interface RetentionPolicy {
  /** The newest backup of each of this many recent days is kept. */
  daily: number;
  /** The newest backup of each of this many recent months is kept. */
  monthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { daily: 30, monthly: 12 };

/**
 * Which backups to keep and which to delete: the newest of each of the last 30 days and of each of
 * the last 12 months. The very newest is always kept. Nothing is ever kept just because it is
 * recent: two backups on one day leave one.
 */
export function retentionPlan(
  files: readonly BackupFileInfo[],
  nowMs: number,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): { keep: string[]; remove: string[] } {
  const newestFirst = [...files].sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  const keep = new Set<string>();
  if (newestFirst[0]) keep.add(newestFirst[0].name);
  const dayLimit = startOfIstDay(nowMs) - (policy.daily - 1) * DAY;
  const monthKeys = new Set<string>();
  const [y, mo] = istMonth(nowMs).split('-').map(Number) as [number, number];
  for (let back = 0; back < policy.monthly; back++) {
    const idx = y * 12 + (mo - 1) - back;
    monthKeys.add(
      `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`,
    );
  }
  const days = new Set<string>();
  const months = new Set<string>();
  for (const f of newestFirst) {
    const day = istDay(f.at);
    const month = istMonth(f.at);
    if (f.at >= dayLimit && !days.has(day)) {
      days.add(day);
      keep.add(f.name);
    }
    if (monthKeys.has(month) && !months.has(month)) {
      months.add(month);
      keep.add(f.name);
    }
  }
  return {
    keep: newestFirst.filter((f) => keep.has(f.name)).map((f) => f.name),
    remove: newestFirst.filter((f) => !keep.has(f.name)).map((f) => f.name),
  };
}

/** The browser cannot back up to a folder on its own, so it asks for a download every 7 days. */
export const DOWNLOAD_REMINDER_DAYS = 7;

/**
 * Whether to remind someone to download a backup. `since` is when this device first held data (so a
 * brand new install is not nagged on day one); `lastDownloadAt` is their last downloaded backup.
 */
export function downloadReminderDue(
  lastDownloadAt: number | null,
  since: number,
  nowMs: number,
  days = DOWNLOAD_REMINDER_DAYS,
): boolean {
  const from = Math.max(lastDownloadAt ?? 0, since);
  return nowMs - from >= days * DAY;
}

/** What the trash keeps things for. */
export const TRASH_RETENTION_DAYS = 30;

/** When something put in the trash at `deletedAt` is removed for good. */
export const trashPurgeAt = (deletedAt: number, days = TRASH_RETENTION_DAYS): number =>
  deletedAt + days * DAY;

export const isTrashExpired = (
  deletedAt: number,
  nowMs: number,
  days = TRASH_RETENTION_DAYS,
): boolean => nowMs >= trashPurgeAt(deletedAt, days);

/** Whole days left before it goes, never below zero. */
export const trashDaysLeft = (
  deletedAt: number,
  nowMs: number,
  days = TRASH_RETENTION_DAYS,
): number => Math.max(0, Math.ceil((trashPurgeAt(deletedAt, days) - nowMs) / DAY));

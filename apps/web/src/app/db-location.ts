/**
 * Which copy of the database the app opens. Normally one; a restore builds a second one beside it,
 * checks it, and then points the app at it with a single write. If the new copy ever fails to open,
 * the app goes back to the previous one by itself, so a bad restore cannot leave anyone locked out.
 * This lives in `localStorage` because it must survive a database being replaced.
 */
export interface DbLocation {
  /** The OPFS directory that holds the database's pool of files. */
  dir: string;
  file: string;
}

export const DEFAULT_LOCATION: DbLocation = { dir: '/gst-desk', file: 'gst-desk.sqlite3' };

const ACTIVE = 'gst.db.active';
const PREVIOUS = 'gst.db.previous';
const PENDING = 'gst.db.pending';
const FELL_BACK = 'gst.db.fellBack';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage may be blocked: the app then keeps using the default copy
  }
}

const valid = (l: DbLocation | null): l is DbLocation =>
  !!l && typeof l.dir === 'string' && l.dir.startsWith('/') && typeof l.file === 'string';

export const activeLocation = (): DbLocation => {
  const l = read<DbLocation>(ACTIVE);
  return valid(l) ? l : DEFAULT_LOCATION;
};

export const previousLocation = (): { location: DbLocation; since: number } | null => {
  const l = read<{ location: DbLocation; since: number }>(PREVIOUS);
  return l && valid(l.location) ? l : null;
};

/** The restored copy has not opened successfully yet. */
export const switchPending = (): boolean => read<{ at: number }>(PENDING) !== null;

/** Point the app at `next`. The one that was in use is kept as the way back. */
export function switchTo(next: DbLocation, now = Date.now()): void {
  const current = activeLocation();
  write(PREVIOUS, { location: current, since: now });
  write(PENDING, { at: now });
  write(ACTIVE, next);
}

/** The new copy opened and migrated: the switch is final. */
export function confirmSwitch(): void {
  write(PENDING, null);
}

/**
 * The new copy would not open: go back to the one before it. Returns where the app now points, or
 * null when there was nothing to go back to.
 */
export function revertSwitch(): DbLocation | null {
  const prev = previousLocation();
  if (!prev || !switchPending()) return null;
  write(ACTIVE, prev.location);
  write(PENDING, null);
  write(PREVIOUS, null);
  try {
    sessionStorage.setItem(FELL_BACK, '1');
  } catch {
    // only the notice is lost
  }
  return prev.location;
}

/** Whether the app has just gone back to the previous copy (shown once, then cleared). */
export function takeFellBackNotice(): boolean {
  try {
    const v = sessionStorage.getItem(FELL_BACK) === '1';
    if (v) sessionStorage.removeItem(FELL_BACK);
    return v;
  } catch {
    return false;
  }
}

/** The previous copy has been kept long enough: forget it (its files are removed by the caller). */
export function forgetPrevious(): DbLocation | null {
  const prev = previousLocation();
  write(PREVIOUS, null);
  return prev?.location ?? null;
}

/** A name for a new staging copy that cannot clash with another. */
export const stagingLocation = (now = Date.now()): DbLocation => ({
  dir: `/gst-desk-restore-${now.toString(36)}`,
  file: 'gst-desk.sqlite3',
});

/** Remove an OPFS directory and everything in it. Never throws: a stale directory is only wasted space. */
export async function removeLocationFiles(l: DbLocation): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(l.dir.replace(/^\//, ''), { recursive: true });
  } catch {
    // already gone, or OPFS is not available
  }
}

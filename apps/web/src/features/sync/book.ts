/**
 * Which cloud business this device opens (prompt 43). Chosen on the account screen after signing in;
 * kept on the device beside the session. With one chosen (and the sync client available, which today
 * means the phone app), the app opens that organisation's synced book instead of a local one.
 */
export interface CloudBook {
  orgId: string;
  orgName: string;
  businessId: string;
  businessName: string;
  userId: string;
}

const KEY = 'gst.cloud.book';

export function readCloudBook(get: (k: string) => string | null): CloudBook | null {
  try {
    const raw = get(KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as CloudBook;
    return b.orgId && b.businessId && b.userId ? b : null;
  } catch {
    return null;
  }
}

export const writeCloudBook = (set: (k: string, v: string | null) => void, b: CloudBook | null) =>
  set(KEY, b ? JSON.stringify(b) : null);

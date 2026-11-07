/**
 * Anonymous usage counters, opt-in, off by default. What can ever be counted is the fixed list below:
 * the name of a feature and how many times it was used. Nothing a person typed, no names, GSTINs,
 * amounts, document numbers or file names, and nothing that identifies the business. Anything not on
 * the list is dropped here, so a call site cannot widen what is collected by mistake. What would be
 * sent can be read, exactly, on Settings, Privacy.
 */

export const FEATURES = [
  'app_opened',
  'invoice_issued',
  'purchase_recorded',
  'payment_recorded',
  'party_added',
  'item_added',
  'report_opened',
  'report_exported',
  'backup_made',
  'backup_restored',
  'inbox_accepted',
  'inbox_rejected',
  'import_done',
  'pdf_saved',
  'language_changed',
  'help_opened',
  'ai_scan',
  'ai_voice',
] as const;
export type Feature = (typeof FEATURES)[number];

export interface TelemetryState {
  /** Counts by feature since the last send. */
  counts: Partial<Record<Feature, number>>;
  /** A random id for this install, so one install is not counted twice. It is not derived from anything. */
  installId: string;
  /** When the counters were last sent (epoch milliseconds), or null. */
  lastSentAt: number | null;
}

export interface Payload {
  v: 1;
  installId: string;
  appVersion: string;
  platform: 'web' | 'desktop';
  counts: Partial<Record<Feature, number>>;
}

export const isFeature = (f: unknown): f is Feature =>
  typeof f === 'string' && (FEATURES as readonly string[]).includes(f);

export function emptyState(newId: () => string): TelemetryState {
  return { counts: {}, installId: newId(), lastSentAt: null };
}

/** Add one use of a feature; unknown names change nothing. */
export function record(state: TelemetryState, feature: unknown): TelemetryState {
  if (!isFeature(feature)) return state;
  return { ...state, counts: { ...state.counts, [feature]: (state.counts[feature] ?? 0) + 1 } };
}

/** Keep only well-formed counts for features on the list (what a stored or edited value may hold). */
export function clean(raw: unknown): Partial<Record<Feature, number>> {
  const out: Partial<Record<Feature, number>> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isFeature(k) && typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e9)
      out[k] = v;
  }
  return out;
}

/** What would be sent, and nothing else. */
export function payload(
  state: TelemetryState,
  appVersion: string,
  platform: Payload['platform'],
): Payload {
  return { v: 1, installId: state.installId, appVersion, platform, counts: clean(state.counts) };
}

const WEEK = 7 * 24 * 3_600_000;

/** Send at most once a week, and only when there is something to send. */
export function sendDue(state: TelemetryState, now: number): boolean {
  if (Object.keys(clean(state.counts)).length === 0) return false;
  return state.lastSentAt === null || now - state.lastSentAt >= WEEK;
}

/** After a successful send the counters start again; the install id stays. */
export function afterSend(state: TelemetryState, now: number): TelemetryState {
  return { ...state, counts: {}, lastSentAt: now };
}

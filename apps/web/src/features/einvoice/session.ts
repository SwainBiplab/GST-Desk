/**
 * The GSP session on this device: which adapter to use, the credentials unlocked for this session only,
 * and the practice portal's memory. Credentials are kept sealed with the person's PIN in settings and
 * are held unsealed in memory only, never in storage; closing the app (or "Lock now") forgets them.
 */
import { EinvoiceRepo, GstrRepo, type Ctx, type Database, type GspConfig } from '@gst/db';
import {
  GspClient,
  MockGspAdapter,
  VendorXAdapter,
  openCredentials,
  sealCredentials,
  type GspAdapter,
  type GspCredentials,
  type MockState,
  type SealedCredentials,
} from '@gst/gsp';
import { useSyncExternalStore } from 'react';

/* ------------------------------------------------------------ unlocked credentials (memory only) */

const unlocked = new Map<string, GspCredentials>();
const listeners = new Set<() => void>();
const emit = () => {
  clients.clear();
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Called when credentials are unlocked or locked (the queue runner starts sending at once). */
export const onSessionChange = subscribe;

/** Whether this business's credentials are unlocked in this session. */
export function useUnlocked(businessId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => (businessId ? unlocked.has(businessId) : false));
}

/** Open the sealed credentials with the PIN. Throws `WrongPinError` for a wrong PIN. */
export async function unlock(database: Database, ctx: Ctx, pin: string): Promise<void> {
  const sealed = (await new EinvoiceRepo(database).sealedCredentials(
    ctx,
  )) as SealedCredentials | null;
  if (!sealed) throw new Error('No credentials are saved.');
  unlocked.set(ctx.businessId, await openCredentials(sealed, pin));
  emit();
}

/** Forget the unlocked credentials; requests wait in the queue until the PIN is given again. */
export function lock(businessId: string): void {
  unlocked.delete(businessId);
  emit();
}

/** Seal the credentials with the PIN, save them, and keep them unlocked for this session. */
export async function saveCredentials(
  database: Database,
  ctx: Ctx,
  creds: Omit<GspCredentials, 'gstin'>,
  pin: string,
): Promise<void> {
  const { gstin } = await new GstrRepo(database).businessInfo(ctx);
  const full: GspCredentials = { ...creds, gstin };
  const sealed = await sealCredentials(full, pin);
  await new EinvoiceRepo(database).saveSealedCredentials(ctx, sealed);
  unlocked.set(ctx.businessId, full);
  emit();
}

/* ------------------------------------------------------------ the practice portal */

const practiceKey = (businessId: string) => `gst.gsp.practice.${businessId}`;
const practice = new Map<string, MockGspAdapter>();

function loadPracticeState(businessId: string): MockState | null {
  try {
    const raw = localStorage.getItem(practiceKey(businessId));
    return raw ? (JSON.parse(raw) as MockState) : null;
  } catch {
    return null;
  }
}

/** The practice portal of a business, remembering what it issued before a reload. */
function practiceAdapter(businessId: string): MockGspAdapter {
  let a = practice.get(businessId);
  if (!a) {
    a = new MockGspAdapter({ latencyMs: 150, state: loadPracticeState(businessId) });
    practice.set(businessId, a);
  }
  return a;
}

/** Keep what the practice portal issued, so cancelling after a reload still finds it. */
export function savePractice(businessId: string): void {
  const a = practice.get(businessId);
  if (!a) return;
  try {
    localStorage.setItem(practiceKey(businessId), JSON.stringify(a.state()));
  } catch {
    /* storage may be blocked: the practice portal then forgets on reload */
  }
}

/** The practice portal accepts any user; these say plainly that nothing is real. */
const practiceCredentials = (gstin: string): GspCredentials => ({
  gstin,
  einvUser: 'practice',
  einvPassword: 'practice',
  ewbUser: 'practice',
  ewbPassword: 'practice',
});

/* ------------------------------------------------------------ the client */

/** Which job and document the next log line belongs to; the queue updates it before each job. */
export interface LogLink {
  jobId?: string | null;
  documentId?: string | null;
}

const clients = new Map<string, { client: GspClient; link: LogLink }>();

/**
 * The client for this business and configuration, or null when it cannot send yet (credentials locked,
 * or no GSP address). One client per configuration, so a portal login is reused between runs.
 */
export function clientFor(
  database: Database,
  ctx: Ctx,
  cfg: GspConfig,
  gstin: string,
): { client: GspClient; link: LogLink } | null {
  const b = ctx.businessId;
  const key = `${b}|${cfg.mode}|${cfg.baseUrl ?? ''}|${cfg.sandbox}|${gstin}`;
  const known = clients.get(key);
  if (known) return known;

  let adapter: GspAdapter;
  let credentials: () => GspCredentials | null;
  if (cfg.mode === 'practice') {
    adapter = practiceAdapter(b);
    const creds = practiceCredentials(gstin);
    credentials = () => creds;
  } else {
    if (!cfg.baseUrl || !unlocked.has(b)) return null;
    adapter = new VendorXAdapter({ baseUrl: cfg.baseUrl, sandbox: cfg.sandbox });
    credentials = () => unlocked.get(b) ?? null;
  }
  const repo = new EinvoiceRepo(database);
  const link: LogLink = {};
  const client = new GspClient(adapter, {
    credentials,
    // the link is copied now: by the time the write runs, the queue may be on the next job
    log: (e) => repo.writeLog(ctx, e, { ...link }),
  });
  const made = { client, link };
  clients.set(key, made);
  return made;
}

/** Forget cached clients (after the GSP settings change). */
export function resetClients(): void {
  clients.clear();
}

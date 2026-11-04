/**
 * The HSN/SAC master in the app: load the version bundled with the install, and (only when the
 * business has set `hsn_update_url`) fetch a newer signed version. Nothing is imported unless its
 * hash and signature check out against the key that ships with the app.
 */
import {
  SettingsRepo,
  importHsnVersion,
  listHsnVersions,
  type Ctx,
  type Database,
  type HsnImportResult,
} from '@gst/db';
import {
  compareVersions,
  verifyHsnManifest,
  type HsnDataFile,
  type HsnManifest,
} from '@gst/domain';
import publicKey from '@gst/domain/data/hsn-signing-key.json';

export const HSN_UPDATE_KEY = 'hsn_update_url';
const MAX_BYTES = 50 * 1024 * 1024;

const KEY = { keyId: publicKey.keyId, publicKeyBase64: publicKey.publicKeyBase64 };

export type TrustedKey = typeof KEY;

/** Import the version that shipped with this install if it is not there yet. */
export async function ensureBundledHsn(d: Database): Promise<HsnImportResult | null> {
  const { BUNDLED_HSN_VERSION, loadBundledHsn } = await import('@gst/domain/data/bundled');
  if ((await listHsnVersions(d)).some((v) => v.version === BUNDLED_HSN_VERSION)) return null;
  const { dataText, data, manifest } = await loadBundledHsn();
  const check = await verifyHsnManifest({ manifest, dataText, publicKey: KEY });
  if (!check.ok) throw new Error(`The bundled HSN master failed verification (${check.reason}).`);
  return importHsnVersion(
    d,
    { version: data.version, as_of: data.as_of, source: data.source, sha256: manifest.sha256 },
    data.rows,
  );
}

export type HsnUpdateResult =
  | { status: 'off' }
  | { status: 'current'; version: string }
  | { status: 'updated'; version: string; rateChanges: number }
  | { status: 'rejected'; reason: 'hash' | 'count' | 'signature' | 'key' }
  | { status: 'error'; message: 'url' | 'network' | 'format' | 'size' };

/** Only https, or plain http to this machine for testing. */
export function isAllowedUpdateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' ||
      (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
    );
  } catch {
    return false;
  }
}

const isManifest = (m: unknown): m is HsnManifest =>
  !!m &&
  typeof m === 'object' &&
  ['version', 'as_of', 'file', 'sha256', 'keyId', 'signature'].every(
    (k) => typeof (m as Record<string, unknown>)[k] === 'string',
  ) &&
  typeof (m as Record<string, unknown>)['count'] === 'number';

async function fetchText(url: string, fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(url, { cache: 'no-store', credentials: 'omit', redirect: 'follow' });
  if (!res.ok) throw new Error('network');
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new Error('size');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('size');
  return text;
}

/** Check the configured address for a newer version and import it when it verifies. */
export async function checkForHsnUpdate(
  d: Database,
  ctx: Ctx,
  fetchFn: typeof fetch = fetch,
  key: TrustedKey = KEY,
): Promise<HsnUpdateResult> {
  const url = await new SettingsRepo(d).getValue<string>(ctx, HSN_UPDATE_KEY);
  if (!url) return { status: 'off' };
  if (!isAllowedUpdateUrl(url)) return { status: 'error', message: 'url' };
  try {
    const manifest: unknown = JSON.parse(await fetchText(url, fetchFn));
    if (!isManifest(manifest)) return { status: 'error', message: 'format' };
    const installed = (await listHsnVersions(d))[0]?.version ?? '0';
    if (compareVersions(manifest.version, installed) <= 0)
      return { status: 'current', version: installed };

    const dataUrl = new URL(manifest.file, url).toString();
    const dataText = await fetchText(dataUrl, fetchFn);
    const check = await verifyHsnManifest({ manifest, dataText, publicKey: key });
    if (!check.ok) return { status: 'rejected', reason: check.reason };
    const data = JSON.parse(dataText) as HsnDataFile;
    const result = await importHsnVersion(
      d,
      { version: data.version, as_of: data.as_of, source: data.source, sha256: manifest.sha256 },
      data.rows,
    );
    return { status: 'updated', version: data.version, rateChanges: result.rateChanges.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    return {
      status: 'error',
      message: message === 'size' ? 'size' : message === 'format' ? 'format' : 'network',
    };
  }
}

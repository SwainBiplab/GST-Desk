/**
 * The HSN/SAC master as versioned data: parsing the curated source CSV, planning an import so rate
 * history is kept, and verifying the signed manifest of a downloaded version. Pure TypeScript.
 */
import { parseCsv, parseScaledStrict } from './csv';

export interface HsnRow {
  code: string;
  description: string;
  rate_bp: number;
  cess_bp: number;
  effective_from: string;
  effective_to?: string | null;
}

export const HSN_CSV_COLUMNS = [
  'code',
  'description',
  'rate_percent',
  'cess_percent',
  'effective_from',
] as const;

/** Services (SAC) all begin with 99. */
export const hsnKind = (code: string): 'goods' | 'service' =>
  code.startsWith('99') ? 'service' : 'goods';

export const isHsnCode = (code: string) => /^(?:\d{2}|\d{4}|\d{6}|\d{8})$/.test(code);

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const dayBefore = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

export interface HsnParseError {
  line: number;
  message: string;
}

/**
 * Parse the curated source file. Columns (header row required, any order):
 * `code, description, rate_percent, cess_percent (optional), effective_from`.
 */
export function parseHsnCsv(text: string): { rows: HsnRow[]; errors: HsnParseError[] } {
  const parsed = parseCsv(text);
  const [header, ...body] = parsed.rows;
  const errors: HsnParseError[] = [];
  if (!header) return { rows: [], errors: [{ line: 1, message: 'the file is empty' }] };
  const col = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]));
  for (const need of ['code', 'description', 'rate_percent', 'effective_from']) {
    if (!col.has(need)) errors.push({ line: 1, message: `missing column "${need}"` });
  }
  if (errors.length > 0) return { rows: [], errors };

  const rows: HsnRow[] = [];
  const seen = new Set<string>();
  body.forEach((cells, i) => {
    const line = parsed.lines[i + 1]!;
    const get = (name: string) => (cells[col.get(name) ?? -1] ?? '').trim();
    const code = get('code');
    const rate = parseScaledStrict(get('rate_percent'), 2);
    const cessText = get('cess_percent');
    const cess = cessText === '' ? 0 : parseScaledStrict(cessText, 2);
    const from = get('effective_from');
    const description = get('description');
    const bad = (message: string) => errors.push({ line, message });
    if (!isHsnCode(code)) return bad(`"${code}" is not a 2, 4, 6 or 8 digit code`);
    if (description === '') return bad(`${code}: description is empty`);
    if (rate === undefined || rate === null) return bad(`${code}: rate_percent is not a number`);
    if (cess === undefined || cess === null) return bad(`${code}: cess_percent is not a number`);
    if (!ISO.test(from) || Number.isNaN(Date.parse(from)))
      return bad(`${code}: effective_from must be YYYY-MM-DD`);
    const key = `${code}|${from}`;
    if (seen.has(key)) return bad(`${code}: appears twice for ${from}`);
    seen.add(key);
    rows.push({ code, description, rate_bp: rate, cess_bp: cess, effective_from: from });
  });
  return { rows, errors };
}

/* ------------------------------------------------------------------ import planning */

export interface HsnRateChange {
  code: string;
  description: string;
  fromBp: number;
  toBp: number;
  fromCessBp: number;
  toCessBp: number;
  effectiveFrom: string;
}

export interface HsnPlan {
  inserts: HsnRow[];
  /** In-place changes to an existing row identified by `(code, effective_from)`. */
  updates: { code: string; effective_from: string; patch: Partial<HsnRow> }[];
  rateChanges: HsnRateChange[];
  unchanged: number;
}

const sameRate = (a: HsnRow, b: HsnRow) => a.rate_bp === b.rate_bp && a.cess_bp === b.cess_bp;

/**
 * Work out how to merge `incoming` into the rows already stored, keeping history: a changed rate
 * closes the previous row the day before and adds a new one. Re-importing the same data changes
 * nothing. A correction with the same effective date updates that row in place.
 */
export function planHsnImport(existing: readonly HsnRow[], incoming: readonly HsnRow[]): HsnPlan {
  const byCode = new Map<string, HsnRow[]>();
  for (const r of existing)
    (byCode.get(r.code) ?? byCode.set(r.code, []).get(r.code)!).push({ ...r });
  for (const h of byCode.values())
    h.sort((a, b) => a.effective_from.localeCompare(b.effective_from));

  const plan: HsnPlan = { inserts: [], updates: [], rateChanges: [], unchanged: 0 };
  const sorted = [...incoming].sort(
    (a, b) => a.code.localeCompare(b.code) || a.effective_from.localeCompare(b.effective_from),
  );

  for (const r of sorted) {
    const history = byCode.get(r.code) ?? [];
    const same = history.find((h) => h.effective_from === r.effective_from);
    const note = (from: HsnRow) => {
      if (!sameRate(from, r))
        plan.rateChanges.push({
          code: r.code,
          description: r.description,
          fromBp: from.rate_bp,
          toBp: r.rate_bp,
          fromCessBp: from.cess_bp,
          toCessBp: r.cess_bp,
          effectiveFrom: r.effective_from,
        });
    };

    if (same) {
      const patch: Partial<HsnRow> = {};
      if (same.description !== r.description) patch.description = r.description;
      if (same.rate_bp !== r.rate_bp) patch.rate_bp = r.rate_bp;
      if (same.cess_bp !== r.cess_bp) patch.cess_bp = r.cess_bp;
      if (Object.keys(patch).length === 0) plan.unchanged++;
      else {
        note(same);
        plan.updates.push({ code: r.code, effective_from: r.effective_from, patch });
        Object.assign(same, patch);
      }
      continue;
    }

    const prev = [...history].reverse().find((h) => h.effective_from < r.effective_from);
    const next = history.find((h) => h.effective_from > r.effective_from);

    if (prev && !next && sameRate(prev, r)) {
      // nothing new to record; keep the wording current
      if (prev.description !== r.description) {
        plan.updates.push({
          code: r.code,
          effective_from: prev.effective_from,
          patch: { description: r.description },
        });
        prev.description = r.description;
      } else plan.unchanged++;
      continue;
    }

    const row: HsnRow = {
      ...r,
      effective_to: next ? dayBefore(next.effective_from) : (r.effective_to ?? null),
    };
    plan.inserts.push(row);
    if (prev) {
      note(prev);
      if (!prev.effective_to || prev.effective_to >= r.effective_from) {
        const to = dayBefore(r.effective_from);
        plan.updates.push({
          code: r.code,
          effective_from: prev.effective_from,
          patch: { effective_to: to },
        });
        prev.effective_to = to;
      }
    }
    history.push(row);
    history.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
    byCode.set(r.code, history);
  }
  return plan;
}

/** The row in force on `asOf`, if any. */
export function rowAsOf(history: readonly HsnRow[], asOf: string): HsnRow | null {
  let best: HsnRow | null = null;
  for (const h of history) {
    if (h.effective_from <= asOf && (!h.effective_to || h.effective_to >= asOf)) {
      if (!best || h.effective_from > best.effective_from) best = h;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ versions and signatures */

/** Compare dotted numeric versions such as `2026.11.1`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface HsnDataFile {
  version: string;
  /** Date the rates in this file were checked against. */
  as_of: string;
  source: string;
  rows: HsnRow[];
}

export interface HsnManifest {
  version: string;
  as_of: string;
  count: number;
  /** File name of the data file, relative to the manifest. */
  file: string;
  sha256: string;
  keyId: string;
  /** Ed25519 signature, base64, over `manifestMessage(manifest)`. */
  signature: string;
}

export const manifestMessage = (m: Pick<HsnManifest, 'version' | 'as_of' | 'count' | 'sha256'>) =>
  `gst-desk-hsn\nv1\n${m.version}\n${m.as_of}\n${m.count}\n${m.sha256}`;

const bytes = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type ManifestCheck =
  { ok: true } | { ok: false; reason: 'hash' | 'count' | 'signature' | 'key' };

/**
 * Check a downloaded version before it is imported: the data matches the hash and row count in the
 * manifest, and the manifest was signed by the key that ships with the app.
 */
export async function verifyHsnManifest(args: {
  manifest: HsnManifest;
  dataText: string;
  publicKey: { keyId: string; publicKeyBase64: string };
}): Promise<ManifestCheck> {
  const { manifest, dataText, publicKey } = args;
  if (manifest.keyId !== publicKey.keyId) return { ok: false, reason: 'key' };
  if ((await sha256Hex(dataText)) !== manifest.sha256) return { ok: false, reason: 'hash' };
  try {
    const data = JSON.parse(dataText) as HsnDataFile;
    if (data.rows.length !== manifest.count || data.version !== manifest.version)
      return { ok: false, reason: 'count' };
    const key = await crypto.subtle.importKey(
      'raw',
      fromBase64(publicKey.publicKeyBase64),
      'Ed25519',
      false,
      ['verify'],
    );
    const good = await crypto.subtle.verify(
      'Ed25519',
      key,
      fromBase64(manifest.signature),
      bytes(manifestMessage(manifest)),
    );
    return good ? { ok: true } : { ok: false, reason: 'signature' };
  } catch {
    return { ok: false, reason: 'signature' };
  }
}

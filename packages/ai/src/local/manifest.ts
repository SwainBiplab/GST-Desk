/**
 * The list of models the app can download: where each is, how big, its hash and licence. The manifest is
 * signed with a key the app carries, so a tampered server cannot point the app at a different file.
 * Nothing in it is trusted before `verifyManifest` says so.
 */
import { z } from 'zod';

export const MODEL_KINDS = ['llm', 'embedding', 'whisper', 'ocr', 'ocr-lang', 'runtime'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export const modelEntrySchema = z.object({
  /** Stable id, e.g. `qwen2.5-1.5b-instruct-q4`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,80}$/),
  kind: z.enum(MODEL_KINDS),
  name: z.string().min(1),
  version: z.string().min(1),
  /** File name under the models folder. */
  file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/),
  url: z.string().url(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  licence: z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    /** Shown before the download; the person accepts it per model. */
    summary: z.string().min(1),
  }),
  /** The least memory the model needs to be offered. */
  minRamGb: z.number().nonnegative(),
  /** Only for these platforms (runtimes); empty means any. */
  platforms: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  /** Free text: parameters, quantisation, what it is good at. */
  notes: z.string().default(''),
});
export type ModelEntry = z.infer<typeof modelEntrySchema>;

export const bundleSchema = z.object({
  deviceClass: z.enum(['minimal', 'baseline', 'capable', 'strong']),
  /** Model ids, in download order. */
  models: z.array(z.string()),
});

export const manifestSchema = z.object({
  /** Format version, not the model versions. */
  format: z.literal(1),
  generatedAt: z.string(),
  models: z.array(modelEntrySchema),
  bundles: z.array(bundleSchema),
  keyId: z.string(),
  signature: z.string(),
});
export type ModelManifest = z.infer<typeof manifestSchema>;
export type UnsignedManifest = Omit<ModelManifest, 'keyId' | 'signature'>;

export interface SigningPublicKey {
  keyId: string;
  algorithm: 'ed25519';
  publicKeyBase64: string;
}

/** Keys sorted at every level so the same manifest always signs the same bytes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const manifestMessage = (m: UnsignedManifest): string =>
  canonical({ format: m.format, generatedAt: m.generatedAt, models: m.models, bundles: m.bundles });

const fromBase64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const copy = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
};

export type ManifestCheck =
  | { ok: true; manifest: ModelManifest }
  | { ok: false; reason: 'shape' | 'key' | 'signature'; detail?: string };

export async function verifyManifest(raw: unknown, key: SigningPublicKey): Promise<ManifestCheck> {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, reason: 'shape', detail: parsed.error.issues[0]?.message ?? 'invalid' };
  const m = parsed.data;
  if (m.keyId !== key.keyId) return { ok: false, reason: 'key' };
  try {
    const k = await crypto.subtle.importKey(
      'raw',
      fromBase64(key.publicKeyBase64),
      'Ed25519',
      false,
      ['verify'],
    );
    const good = await crypto.subtle.verify(
      'Ed25519',
      k,
      fromBase64(m.signature),
      new TextEncoder().encode(manifestMessage(m)),
    );
    return good ? { ok: true, manifest: m } : { ok: false, reason: 'signature' };
  } catch {
    return { ok: false, reason: 'signature' };
  }
}

/** Sign with an Ed25519 private key (PKCS#8 bytes). Used by the release script and by tests. */
export async function signManifest(
  m: UnsignedManifest,
  key: { keyId: string; privateKeyPkcs8: Uint8Array },
): Promise<ModelManifest> {
  const k = await crypto.subtle.importKey('pkcs8', copy(key.privateKeyPkcs8), 'Ed25519', false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('Ed25519', k, new TextEncoder().encode(manifestMessage(m)));
  return { ...m, keyId: key.keyId, signature: btoa(String.fromCharCode(...new Uint8Array(sig))) };
}

/** The models a device class should have, in download order, with the ones it cannot run left out. */
export function bundleFor(
  m: ModelManifest,
  deviceClass: 'minimal' | 'baseline' | 'capable' | 'strong',
  hw: { ramGb: number; platform: string },
): ModelEntry[] {
  const ids = m.bundles.find((b) => b.deviceClass === deviceClass)?.models ?? [];
  const byId = new Map(m.models.map((e) => [e.id, e]));
  return ids
    .map((id) => byId.get(id))
    .filter((e): e is ModelEntry => !!e)
    .filter((e) => e.minRamGb <= hw.ramGb)
    .filter((e) => e.platforms.length === 0 || e.platforms.includes(hw.platform));
}

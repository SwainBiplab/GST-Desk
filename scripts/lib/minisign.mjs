/**
 * Minisign verification as used by the Tauri updater.
 *
 * Tauri stores both the public key (tauri.conf.json `pubkey`) and each `.sig` file as base64 of a
 * minisign text file. Signature algorithm `ED` signs BLAKE2b-512(file); `Ed` signs the raw file.
 */
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeFile(b64) {
  return Buffer.from(b64.trim(), 'base64').toString('utf8');
}

/** Parse the public key. Returns `{ keyId, key }` (key is 32 raw bytes). */
export function parsePublicKey(pubkeyB64) {
  const lines = decodeFile(pubkeyB64).trim().split(/\r?\n/);
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') {
    throw new Error('not a minisign public key');
  }
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

/** Parse a `.sig` file's contents (the base64 blob Tauri writes). */
export function parseSignature(sigB64) {
  const lines = decodeFile(sigB64).trim().split(/\r?\n/);
  const sig = Buffer.from(lines[1] ?? '', 'base64');
  const trusted = (lines[2] ?? '').replace(/^trusted comment: ?/, '');
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (sig.length !== 74 || !['ED', 'Ed'].includes(sig.subarray(0, 2).toString())) {
    throw new Error('not a minisign signature');
  }
  return {
    algorithm: sig.subarray(0, 2).toString(),
    keyId: sig.subarray(2, 10),
    signature: sig.subarray(10),
    trustedComment: trusted,
    globalSignature: global,
  };
}

function ed25519(publicKey, message, signature) {
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, message, key, signature);
}

/**
 * Verify `fileBytes` against a Tauri `.sig` string and `pubkey` string.
 * Returns `{ ok: true }` or `{ ok: false, reason }`; never throws on bad input.
 */
export function verifyMinisign(fileBytes, sigB64, pubkeyB64) {
  let pub;
  let sig;
  try {
    pub = parsePublicKey(pubkeyB64);
    sig = parseSignature(sigB64);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (!pub.keyId.equals(sig.keyId))
    return { ok: false, reason: 'signature was made with a different key' };
  const message =
    sig.algorithm === 'ED' ? createHash('blake2b512').update(fileBytes).digest() : fileBytes;
  if (!ed25519(pub.key, message, sig.signature))
    return { ok: false, reason: 'signature does not match the file' };
  if (sig.globalSignature.length === 64) {
    const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment)]);
    if (!ed25519(pub.key, global, sig.globalSignature)) {
      return { ok: false, reason: 'trusted comment signature does not match' };
    }
  }
  return { ok: true };
}

/** Build a signature/pubkey pair the way minisign does. Used by tests and fixtures only. */
export function makeMinisignFixture({
  privateKey,
  publicKeyRaw,
  keyId,
  fileBytes,
  algorithm = 'ED',
  trusted = 'timestamp:1 file:test',
}) {
  const message =
    algorithm === 'ED' ? createHash('blake2b512').update(fileBytes).digest() : fileBytes;
  const signature = sign(null, message, privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey);
  const sigText =
    `untrusted comment: signature from tauri secret key\n` +
    `${Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString('base64')}\n` +
    `trusted comment: ${trusted}\n` +
    `${global.toString('base64')}\n`;
  const pubText =
    `untrusted comment: minisign public key: ${keyId.toString('hex').toUpperCase()}\n` +
    `${Buffer.concat([Buffer.from('Ed'), keyId, publicKeyRaw]).toString('base64')}\n`;
  return {
    signature: Buffer.from(sigText).toString('base64'),
    pubkey: Buffer.from(pubText).toString('base64'),
  };
}

/**
 * Build a signed version of the HSN/SAC master from the curated CSV.
 *
 *   pnpm hsn:build -- --version 2025.9.1 --as-of 2025-09-22 [--csv file] [--key file.pem]
 *
 * Writes `hsn-v<version>.json` and `hsn-v<version>.manifest.json` to `packages/domain/data/` and
 * points `bundled.ts` at it. The private key is read from `--key`, the `HSN_SIGNING_KEY_PEM`
 * environment variable, or `tools/hsn/.keys/<keyId>.pem`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { SourceError, buildHsnVersion, publicKeyOf, type PublicKeyFile } from './lib';
import { ARGS, PATHS } from './paths';

const { values } = parseArgs({
  args: ARGS,
  options: {
    version: { type: 'string' },
    'as-of': { type: 'string' },
    csv: { type: 'string', default: PATHS.source },
    out: { type: 'string', default: PATHS.data },
    key: { type: 'string' },
    source: { type: 'string', default: 'Curated starter set, unreviewed' },
    'no-bundle': { type: 'boolean', default: false },
  },
});

if (!values.version || !values['as-of']) {
  console.error('Usage: pnpm hsn:build -- --version 2025.9.1 --as-of 2025-09-22');
  process.exit(2);
}

const pub = JSON.parse(await readFile(PATHS.publicKey, 'utf8')) as PublicKeyFile;
const keyFile = values.key ?? join(PATHS.keys, `${pub.keyId}.pem`);
const privateKeyPem =
  process.env['HSN_SIGNING_KEY_PEM'] ??
  (existsSync(keyFile) ? await readFile(keyFile, 'utf8') : null);
if (!privateKeyPem) {
  console.error(`No private key for "${pub.keyId}". Run pnpm hsn:keygen, or pass --key.`);
  process.exit(1);
}
if (publicKeyOf(privateKeyPem) !== pub.publicKeyBase64) {
  console.error(
    `The private key does not match ${PATHS.publicKey}. Refusing to sign with the wrong key.`,
  );
  process.exit(1);
}

try {
  const { manifest } = await buildHsnVersion({
    csvText: await readFile(values.csv!, 'utf8'),
    outDir: values.out!,
    version: values.version,
    asOf: values['as-of'],
    source: values.source!,
    privateKeyPem,
    keyId: pub.keyId,
    bundle: !values['no-bundle'],
  });
  console.log(
    `built ${manifest.file}: ${manifest.count} rows, sha256 ${manifest.sha256.slice(0, 12)}...`,
  );
} catch (e) {
  if (e instanceof SourceError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

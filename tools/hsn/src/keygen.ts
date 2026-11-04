/**
 * Create the HSN signing key pair. The private key goes to `tools/hsn/.keys/` (ignored by git) and
 * the public key to `packages/domain/data/hsn-signing-key.json` (committed, shipped in the app).
 *
 *   pnpm hsn:keygen -- --id hsn-2026-1 [--force]
 *
 * Production: run this on the release owner's machine, keep the private key in the secrets vault,
 * and rebuild the bundled version. The key made during development must not ship.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { generateKeys } from './lib';
import { ARGS, PATHS } from './paths';

const { values } = parseArgs({
  args: ARGS,
  options: {
    id: { type: 'string', default: 'hsn-dev-1' },
    force: { type: 'boolean', default: false },
  },
});

if (existsSync(PATHS.publicKey) && !values.force) {
  console.error(`A public key already exists at ${PATHS.publicKey}. Pass --force to replace it.`);
  process.exit(1);
}
const { privateKeyPem, publicKey } = generateKeys(values.id!);
await mkdir(PATHS.keys, { recursive: true });
await mkdir(dirname(PATHS.publicKey), { recursive: true });
const pem = join(PATHS.keys, `${publicKey.keyId}.pem`);
await writeFile(pem, privateKeyPem, { mode: 0o600 });
await writeFile(PATHS.publicKey, `${JSON.stringify(publicKey, null, 2)}\n`);
console.log(`private key: ${pem} (keep it out of git)`);
console.log(`public key:  ${PATHS.publicKey}`);

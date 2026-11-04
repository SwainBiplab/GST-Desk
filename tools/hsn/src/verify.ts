/** Check every signed version in `packages/domain/data/` against the committed public key. */
import { readFile } from 'node:fs/promises';

import { verifyDirectory, type PublicKeyFile } from './lib';
import { PATHS } from './paths';

const pub = JSON.parse(await readFile(PATHS.publicKey, 'utf8')) as PublicKeyFile;
const reports = await verifyDirectory(PATHS.data, pub);
for (const r of reports)
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.file}${r.reason ? ` (${r.reason})` : ''}`);
if (reports.length === 0 || reports.some((r) => !r.ok)) process.exit(1);

/**
 * Run by the chaos test in a separate process: restore a backup over a database file and kill this
 * process at a chosen moment, as a crash or a power cut would. Usage:
 *   tsx restore-child.ts <db file> <backup file> <when>
 * where <when> is `mid-rows`, `before-swap` or `between-renames`.
 */
import { readFileSync } from 'node:fs';

import { restoreIntoFile } from '../node-files';

const [file, backupPath, when] = process.argv.slice(2) as [string, string, string];
const die = () => process.kill(process.pid, 'SIGKILL');

await restoreIntoFile({
  file,
  backup: new Uint8Array(readFileSync(backupPath)),
  onBatch: (table, rows) => {
    if (when === 'mid-rows' && table === 'document_lines' && rows > 100) die();
  },
  beforeSwap: () => {
    if (when === 'before-swap') die();
  },
  betweenRenames: () => {
    if (when === 'between-renames') die();
  },
});
console.log('finished without being stopped');

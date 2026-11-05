/** Rewrites docs/export-schema.md from the schema. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { exportSchemaDoc } from '../src/backup/schema-doc';

const file = join(import.meta.dirname, '..', '..', '..', 'docs', 'export-schema.md');
writeFileSync(file, exportSchemaDoc());
console.log('wrote', file);

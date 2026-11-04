import { rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from '../src/migrate';
import { openSqlite } from '../src/node';
import { seedDemo } from '../src/seed';

const file = resolve(process.argv[2] ?? 'demo.sqlite');
for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });

const started = performance.now();
const d = await openSqlite(`file:${file}`);
await migrate(d);
const { counts } = await seedDemo(d);
await d.close();
const secs = ((performance.now() - started) / 1000).toFixed(2);
const mb = (statSync(file).size / 1024 / 1024).toFixed(2);
console.log(`seeded ${file} in ${secs}s (${mb} MB)`, counts);

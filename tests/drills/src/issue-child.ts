/**
 * Run by the power-loss drill in its own process: issue invoices into a database file, one after the
 * other, until it is killed. Usage: `node --import tsx issue-child.ts <db file>`.
 * It prints `ready`, then `issued <n>` after every invoice, so the parent knows how far it got.
 */
import { issueOne, openBook } from './helpers';

const file = process.argv[2]!;
const book = await openBook(file);
console.log('ready');
for (let n = 1; ; n++) {
  await issueOne(book);
  console.log(`issued ${n}`);
}

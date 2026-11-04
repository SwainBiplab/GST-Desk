import { fileURLToPath } from 'node:url';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/** Where the curated source lives, where signed versions are written, where private keys are kept. */
export const PATHS = {
  source: here('../source/hsn-starter.csv'),
  data: here('../../../packages/domain/data'),
  keys: here('../.keys'),
  publicKey: here('../../../packages/domain/data/hsn-signing-key.json'),
};

/** Command-line arguments without the `--` that pnpm forwards. */
export const ARGS = process.argv.slice(2).filter((a) => a !== '--');

# @gst/hsn-tools

Build, sign and verify versions of the HSN/SAC master. Maintenance steps for reviewers: `docs/runbooks/hsn-master.md`. Design: `docs/decisions/0004-items-and-hsn-master.md`.

| Command                                                       | What it does                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm hsn:keygen --id <keyId> [--force]`                      | Make an Ed25519 key pair. Private key to `.keys/` (git-ignored), public key to the domain package. |
| `pnpm hsn:build --version <v> --as-of <date> [--csv] [--key]` | CSV to `packages/domain/data/hsn-v<v>.json` and a signed manifest; updates `bundled.ts`.           |
| `pnpm hsn:verify`                                             | Check every manifest in `packages/domain/data/` against the committed public key.                  |
| `pnpm --filter @gst/hsn-tools test`                           | Build, tamper and key tests, plus checks on the version that ships.                                |

Public API (`src/lib.ts`): `buildHsnVersion`, `serialiseData`, `bundledModule`, `generateKeys`, `publicKeyOf`, `verifyDirectory`. Parsing, import planning and signature checks live in `@gst/domain` (`hsn.ts`) so the app uses the same code.

The source file `source/hsn-starter.csv` is a starter set (common chapters and every SAC heading, rates as of 22 September 2025) that has **not** been reviewed by a chartered accountant.

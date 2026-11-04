# Runbook: maintaining the HSN/SAC master

For the chartered accountant who reviews the data and the release owner who signs it. See ADR 0004 for why it works this way.

## 1. Edit the source

`tools/hsn/source/hsn-starter.csv` is the working file. One row per code and effective date:

| Column           | Meaning                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `code`           | 2, 4, 6 or 8 digits. Services (SAC) start with 99.                       |
| `description`    | Wording from the tariff. This is what suggestions search.                |
| `rate_percent`   | GST rate: `18`, `5`, `1.5`, `0.25`.                                      |
| `cess_percent`   | Compensation cess, blank for none.                                       |
| `effective_from` | `YYYY-MM-DD`: the date this rate starts.                                 |
| `notes`          | Free text for reviewers (conditions such as a price threshold). Ignored. |

To change a rate, **add a row** for the same code with the new rate and the new `effective_from`. Do not edit the old row: the history of rates is what lets an old document be explained. A correction to a row with the same effective date is edited in place.

Every row in the starter file is marked unreviewed in its notes where the rate depends on a condition. Remove a note only after checking it.

## 2. Build and sign

```powershell
pnpm hsn:build --version 2026.4.0 --as-of 2026-04-01
pnpm hsn:verify
```

`--version` is dotted numbers and must be higher than the last one; `--as-of` is the date you checked the rates against. The build stops and lists every bad line (with its line number) if the CSV has a problem. It writes `hsn-v<version>.json` and `hsn-v<version>.manifest.json` to `packages/domain/data/` and points `bundled.ts` at the new version, so the next installer ships it.

The private key is read from `--key`, the `HSN_SIGNING_KEY_PEM` environment variable, or `tools/hsn/.keys/<keyId>.pem`. The build refuses to sign if the key does not match `packages/domain/data/hsn-signing-key.json`.

## 3. Keys

- `pnpm hsn:keygen --id hsn-2026-1 --force` makes a key pair: the private key goes to `tools/hsn/.keys/` (ignored by git), the public key to `hsn-signing-key.json` (committed, shipped in the app).
- **The key in the repository today is a development key.** Before the first release the release owner makes a production key, keeps the private half in the secrets vault, commits the new public key and rebuilds the bundled version. Installed apps trust the public key they shipped with, so rotating it means shipping an app update; keep the old key's versions out of the update folder afterwards.
- Never commit a private key. CI only needs `pnpm hsn:verify`, which uses the public key.

## 4. Publish an update without an app release

1. Upload `hsn-v<version>.json` and `hsn-v<version>.manifest.json` to the same folder on an https address.
2. Customers set that manifest's address under Items, HSN master, "Update address", then "Check for update".
3. The app downloads the file the manifest names, checks the hash, the row count and the signature, imports it, and the **GST rate changes** banner on the Items page lists the items whose rate moved. Nothing is fetched if the address is empty.

## 5. If something looks wrong

| Symptom                             | Meaning                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| "The update was refused"            | Hash, row count or signature did not match: the file was changed after signing, or signed by another key. Rebuild it. |
| "Could not reach the address"       | Network or address problem. Nothing was changed.                                                                      |
| Banner lists items you did not want | Those items follow the master. Set their rate by hand once; they are then treated as overridden and left out.         |
| Version already installed           | Importing a version twice does nothing. Bump `--version` when the data changes.                                       |

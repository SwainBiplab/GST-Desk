# Signing and key management

Two kinds of signature protect a release: the **updater signature** (Tauri minisign key; clients refuse an update that does not verify) and the **platform code signature** (Apple notarisation, Windows Authenticode) that keeps operating systems from warning users.

## Updater key (Tauri / minisign)

Generate once, on a trusted machine:

```
pnpm --filter desktop tauri signer generate -w gst-desk-updater.key
```

- The command writes the **private key** file and prints the **public key**. Choose a strong password.
- Public key: commit it in `tauri.conf.json` (`plugins.updater.pubkey`) and set the repository variable `TAURI_UPDATER_PUBKEY`. It is not secret.
- Private key and password: store as repository (or environment) secrets `TAURI_SIGNING_PRIVATE_KEY` (the file's contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep an offline encrypted copy with two named custodians.
- Never commit the key, paste it into an issue, or print it in a workflow. The workflows pass it only through `env:`; no step echoes it.

**Rotation.** Clients only trust the public key baked into the build they run. To rotate: ship a release signed with the **old** key that contains the **new** public key; once adoption is high, switch signing to the new key. If the private key leaks, ship that bridging release immediately, revoke the old secrets, and tell users to update from the website.

**Lost key.** Existing installs can no longer receive updates. Users must download a fresh installer. Keep the offline copy.

## macOS signing and notarisation

Needs an Apple Developer account. Secrets: `APPLE_CERTIFICATE` (base64 `.p12` of a Developer ID Application certificate), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), `APPLE_TEAM_ID`. `tauri-action` picks these up from the environment and signs and notarises. Until they exist, macOS builds are unsigned and only fit for internal testing.

## Windows code signing

Secrets `WINDOWS_CERTIFICATE` (base64 PFX) and `WINDOWS_CERTIFICATE_PASSWORD` are placeholders. Wire them in `tauri.conf.json` under `bundle.windows` (`certificateThumbprint`, `timestampUrl`) or replace them with a cloud signing service or HSM: EV certificates now normally require hardware. Decide the provider before the first public release.

## Rules

1. Secrets live only in GitHub secrets and the offline custodian copies.
2. Release signing happens in CI, never on a developer laptop.
3. Use a protected environment (`release`) with required reviewers for the secrets once the repository has more than one maintainer.
4. Verify every release with `pnpm release:verify`; it checks each updater signature against the public key.
5. Record key creation, rotation and custodian changes in this file's history.

## Workflow supply chain

Third-party actions (`pnpm/action-setup`, `dtolnay/rust-toolchain`, `swatinem/rust-cache`, `tauri-apps/tauri-action`, `changesets/action`) are pinned to full commit SHAs, with the tag in a comment. Dependabot's `github-actions` group proposes SHA bumps weekly; review them like any dependency change. Signing secrets are passed only to the Build step, so no other action in the job can read them. `scripts/test/workflows.test.mjs` fails if a third-party action is pinned to a tag or if a job-level `env` carries secrets.

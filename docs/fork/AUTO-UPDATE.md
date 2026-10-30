# Gentle Dot QA updates

The macOS updater uses Tauri Updater v2. Native CI and a real-Mac signed A-to-B
update test are still required before release.

## Behavior

- Checks at startup, every 24 hours, and through **Check for updates**.
- Examines the latest 100 releases in the repository compiled into the app.
  Accepts only published prereleases tagged `macos-qa-vX.Y.Z-N` with a strictly
  newer app version. Stable-channel updates are not implemented.
- Validates the selected release's `latest.json`, version and artifact URL.
  Downloads require TLS, a valid signature and a signed version
  (`requireSignedVersion: true`). Use a Tauri CLI that includes the version in
  the signature's trusted comment; never disable this requirement.
- Asks before downloading, then asks before installing and restarting.
  After verification and confirmation, stops recording, computer control and
  the daemon. Requests a daemon restart if installation fails.
- Does not modify conversations, preferences, credentials or memory. Users must
  save active work before confirming; unsaved work is not detected automatically.
- Runs only in the native shell, without updater permissions in the webview.
  The repository and public key are compiled in, not read from runtime variables.
- Logs automatic check failures without blocking chat. Manual checks show an
  error. Builds without a public key do not check or download updates.

## Signing setup

From a checkout with dependencies installed:

```bash
pnpm --filter @gentle-dot/desktop exec tauri signer generate -w ~/.tauri/gentle-dot.key
```

Keep the private key and its password securely outside the repository. Losing
this key prevents updates to installations that trust it.

In the release repository's **Settings → Secrets and variables → Actions**, set:

| Type | Name | Value |
|---|---|---|
| Variable | GENTLE_DOT_UPDATE_PUBLIC_KEY | Contents of gentle-dot.key.pub |
| Secret | TAURI_SIGNING_PRIVATE_KEY | Contents of gentle-dot.key |
| Secret | TAURI_SIGNING_PRIVATE_KEY_PASSWORD | Key password |

Never include private values in issues, commits or logs. Updater signing does
not replace Apple code signing or notarization.

CI sets `GENTLE_DOT_UPDATE_REPOSITORY` to its own repository. Without that build
variable, the default is `Gentleman-Programming/gentle-dot`. Forks configure
separate keys and publish their own updates.

## Publishing

1. Increase the app version in `tauri.conf.json`, `Cargo.toml`, `Cargo.lock` and
   the desktop `package.json`. Changing only the tag's build suffix does not
   update an installed app with the same X.Y.Z version.
2. Push a reviewed `macos-qa-vX.Y.Z-N` tag. Tag builds require both signing keys;
   branch and PR builds receive no private key and produce only a DMG.
3. Review the draft release containing the DMG, `.app.tar.gz`, `.sig`,
   `latest.json`, build information, license and checksums.
4. Test on a real Mac before publishing the draft as a prerelease. Published
   prereleases become discoverable by configured apps; no mutable feed branch
   or `releases/latest` endpoint is used.

## Release validation

Install A with the public key, publish signed B, and verify the update preserves
data and leaves one daemon running. Test invalid signatures, mismatched signed
versions, truncated downloads, downgrades, offline operation, deferral, wrong
channels and active tasks. Checksums alone do not validate this flow.

App replacement depends on Tauri's native installer; automatic rollback after
arbitrary filesystem failures is not guaranteed.

Reference: https://v2.tauri.app/plugin/updater/

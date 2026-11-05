# macOS QA installation and builds

This branch adds Apple Silicon QA distribution to the existing Gentle Dot
packager. Builds are not available until CI succeeds. Fork builds retain the
upstream license and branding and are not official releases.

## Install

Requires Apple Silicon and macOS 12.3 or later according to upstream. CI tests
macOS 15 ARM64, not every supported OS version. Intel builds are not included.

1. Open a successful **Actions → macOS QA installer** run.
2. Download `gentle-dot-macos-arm64-<commit>` and extract it. GitHub requires
   sign-in; artifacts expire after 14 days.
3. Run `shasum -a 256 -c SHA256SUMS` in the extracted folder.
4. Open the DMG, drag Gentle Dot to Applications, and eject the disk.
5. If macOS blocks the verified build, follow the upstream
   [installation guide](../install.md). Do not disable Gatekeeper globally.
6. Sign in to your provider inside the app. In **Connectors → Computer**, grant
   Accessibility and Screen Recording only if you want computer control.
   Restart after granting screen access.

The app bundles Node, its engine and Engram. Initial component setup may need
Internet. QA builds use ad-hoc signing and are not Apple-notarized; updates may
require permissions again. App data lives in `~/.gentle-dot`; shared memory lives
in `~/.engram`. Preserve shared memory when uninstalling.

## Build from source

Install Node 24, pnpm 11.5.0, Rust 1.96.1 and Xcode Command Line Tools on a Mac:

```bash
pnpm install --frozen-lockfile
pnpm package:mac --check
node scripts/package/collect-macos-qa.mjs
```

Output: `dist/macos-qa`. Move previous output before collecting again; nonempty
output directories are rejected to avoid mixing artifacts.

To work on the fork:

```bash
git clone https://github.com/Maicololiveras/gentle-dot.git
cd gentle-dot
git switch ci/macos-distribution
git remote add upstream https://github.com/Gentleman-Programming/gentle-dot.git
```

Pushes to this branch trigger CI. A local Mac is not required to run GitHub
Actions. Manual dispatch appears in the UI once the workflow exists on the
default branch; until then, push or rerun an existing workflow.

## CI and releases

CI runs frozen dependency installation, lint, type checks, packaging tests,
UI build, Rust checks/tests and `pnpm package:mac --check`. The packager checks
signatures, runtime files and modes, mounts the DMG, and smoke-tests the daemon
with a clean home and read-only runtime. It does not test GUI, physical dictation,
TCC permissions or provider authentication.

Artifacts include the DMG, license, `BUILD-INFO.json` and `SHA256SUMS`. PR builds
have read-only repository permissions and no signing secrets. Only tag packaging
receives signing secrets; only the draft-release job has contents-write access.
Build provenance records resolved runtime versions; byte-for-byte reproducibility
is not claimed.

See [QA updates](AUTO-UPDATE.md) for signing setup and release validation.
From a reviewed commit, with signing configured and the app version matching:

```bash
# Example for app version 0.1.0; choose an unused build suffix.
git tag -a macos-qa-v0.1.0-1 -m "macOS QA 0.1.0 build 1"
git push origin macos-qa-v0.1.0-1
```

CI creates a draft prerelease after checks pass. Test the installer on a real Mac
before publishing. Existing releases are not overwritten. Rerun failed jobs if
no release was created; otherwise inspect the draft or use a new tag.

## Troubleshooting

- Use an ARM64 runner for this packager.
- For proxy or certificate failures, configure the corporate CA/proxy for the
  failing service. Keep TLS verification enabled.
- Update dependencies and lockfiles together; keep frozen installation in CI.
- Fix failing checks before publishing. The daemon smoke test does not validate
  provider login; complete sign-in inside the installed app.

## References

Based on upstream [installation documentation](../install.md),
`package-mac.mjs`, `stage-runtime.mjs` and their tests at
`4c002060fa66554114b89a119c7669f7b8de35c6`.
The [Gentle Shell publishing workflow](https://github.com/Gentleman-Programming/gentle-shell/blob/main/.github/workflows/publish.yml)
informs build/verification/artifact separation, pinned actions and minimal
permissions. npm publishing is not used for this desktop distribution.

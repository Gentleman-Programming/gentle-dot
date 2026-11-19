# Gentle Dot downloads

A static public page; no app or package-manager installation is performed by the browser.
The repository currently has no verified public release. Until a stable release has matching assets, downloads remain unavailable—not linked to QA artifacts.

## Release contract

Source: `https://api.github.com/repos/Gentleman-Programming/gentle-dot/releases/latest`, fetched without credentials. Only non-draft/non-prerelease releases with an official repository release URL qualify. The adapter uses each actual `browser_download_url`, validates its exact HTTPS repository/tag/filename path, rejects QA/preview names and ambiguous targets, and requires an uploaded, nonempty asset.

Publish native CI outputs as stable GitHub Release assets. Include an unambiguous architecture token (`x64`, `x86_64`, `amd64`, `arm64`, `aarch64`) and the existing producer format: Windows `-setup.exe`, macOS `.dmg`, Linux `.deb` (Debian/Ubuntu). Naming such as `gentle-dot-windows-x64-setup.exe` is an example publishing convention, not an existing artifact or URL. Other formats remain accessible on the official release page, not silently labeled as supported installers here.

No URL is constructed for an executable, no Actions download/token endpoint is used, and no API text is interpreted as HTML. A URL/inventory check is not publisher signature verification or native acceptance. Existing CI is QA-only; promoting its outputs and validating release provenance remain separate release work.

## Checks

```sh
node --test web/downloads/releases.test.mjs
```

Tests use synthetic release JSON and fake fetches only. They never download or execute binaries.

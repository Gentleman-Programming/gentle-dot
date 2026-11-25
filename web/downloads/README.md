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

## Local functional preview

```sh
node web/downloads/serve.mjs
# Open http://127.0.0.1:4173
```

The preview server binds loopback only and serves a fixed allowlist of page assets; it never lists directories or serves tests/profile data. An occupied port fails rather than killing another process. Stop only this owned server when finished.

With an already installed Playwright test dependency and Chromium/Edge, run the browser check in a separate terminal:

```sh
GENTLE_DOT_TEST_BROWSER=/absolute/path/to/chromium node web/downloads/browser-check.mjs
```

No browser is installed by the check. It starts an owned browser with a NEW profile under `build/download-page-checks`, connects over CDP, intercepts all release API/download requests with synthetic data and retains screenshots/profile/download evidence. It never uses an existing personal profile, executes an installer or deletes the retained run. Browser-process environment is limited to Windows/process metadata; the parent Node runtime options remain inherited unchanged. Do not use a real provider account for these checks.

## Hosting

Deploy only `index.html`, `styles.css`, `app.mjs`, `releases.mjs` and `hero.png` together on an HTTPS static host. No build step, app dependencies, credentials or backend are required. Keep relative file paths intact; the canonical public repository is in `releases.mjs`. A restrictive CSP is included in the HTML. The current implementation does not create a GitHub release, change repository Pages settings, turn QA artifacts into stable assets, or install anything.

The page suggests an operating system only for recognized Windows, macOS or Linux browsers. Android, iOS and unknown systems start with neither selection filled in. A processor is suggested only when a recognized non-Mac browser explicitly names a supported architecture; Mac users choose between Intel and Apple silicon themselves. Linux installers, when available, are Debian/Ubuntu packages (`.deb`).

One status area shows when the page is checking, needs a selection, finds a matching installer, finds no match or published installer, or cannot check releases. A download link appears only when both selections match a validated asset. “Check again” keeps keyboard focus while the check runs, and “View official releases” remains available throughout (linking to the validated release notes when provided).

The selected system has a checkmark as well as a color change. The page supports forced colors, increased contrast, a visible keyboard focus outline and reduced motion. There is no anonymous production download to certify while the repository has no release.

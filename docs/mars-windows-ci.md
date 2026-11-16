# Mars Windows test artifacts

Push a reviewed candidate to `build/mars-windows-ci-*` to bootstrap
`mars-windows-artifacts.yml`. The new workflow has one Windows 2022 artifact-only
job. Existing workflows are unchanged: the unrestricted baseline macOS push
checks still run their full tests and runtime smoke checks automatically.

The candidate is the integration baseline plus the four Mars #247/#248 UI files.
No local preview, I1, C5, package-manager pin or lockfile changes are included.
Host tools are Node 24.15.0, pnpm 11.5.0, Go 1.25.10 and Rust 1.96.1.
Fresh workspace installation uses the frozen lock and existing lifecycle allowlist
(including gentle-pi 4.7.0). The separate staged production npm install remains
owned by the existing Windows producer; it is not a frozen workspace install.

`./scripts/windows/build-mars-ci.ps1` requires hosted Windows CI; `-Help` describes
its interface. It uses project-owned caches/configs, a bounded child PATH and the
runner's MSVC developer environment. Official Node headers and node.lib must each
have exactly one SHA256 listing entry and match before use. The existing addon
builder supplies Node-API 8, /MD and node.lib without a separate libuv.

The existing `package.ps1 -Target windows-x64` owns fresh staging, current-user
NSIS, the installer path hook and runtime integrity. Its bundled Node 24.14.1 and
Engram 3.4.0 are intentionally distinct from host tools. Packaged-required marker
1 is set before compilation and checked in Cargo build output. Addon checks load
only under host and staged Node; they do not call process termination methods.

Only one `*-setup.exe`, `SHA256SUMS.txt` and `provenance.json` are uploaded from
`build/mars-ci/artifacts` (seven-day retention). Provenance records the candidate,
run, versions, input/output hashes, runtime verification and path-hook evidence.
No workspace, caches, environment dumps or full logs are uploaded.

These are **unsigned test artifacts**, not stable acceptance, signing or installer
acceptance. Nothing installs or launches the app, exercises devices, or invokes
providers. Local policy tests and PowerShell parsing prove source configuration
only. Actual hosted build and downloaded-artifact verification must follow the
parent's reviewed push; until then CI/build/artifact proof is **UNRUN**.

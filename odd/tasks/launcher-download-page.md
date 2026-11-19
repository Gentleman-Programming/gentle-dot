# Launcher download page
Build a complete static Gentle Dot download page backed by actual published CI release assets, not QA artifact URLs.
Branch: feat/launcher-download-page; base:362619c6c03b9817033ace8cff572a7ef1e700aa. Preserve the published Cinlo collaboration branch and all primary WIP.

## Specs
- S1: "muestrame la pagina que se lanzara para instalar?"
- S2: "creala ya completa que funcione perfecto solo sea poner que se bajen los lanzadores y listo"
- S3: "los app se crean en los CIs de cada sistema operativo"

## Tasks
- T1 | S1-S2 | Sync existing brand tokens and create/open one truthful self-contained design direction | route: parent; DONE: existing root tokens synced, one artboard opened on canvas; functional implementation remains T2/T3. Commit:f678b76766c3f38451c31d5b66d43a8269101960.
- T2 | S2-S3 | Implement/test-first real-release discovery and safe target-specific launcher links, including missing/error states | route: inline; DONE self-checks: stub RED2FAIL2PASS then GREEN4PASS/0skip, source URL/target/empty/error contracts; independent T4 pending. Risk2 remote-data/link validation; commit: pending, own unit.
- T3 | S1-S3 | Implement responsive accessible download page using the release adapter, OS/architecture selection and truthful install guidance | route: inline, dependent on T2; IN PROGRESS; commit: pending.
- T4 | S1-S3 | Verify public/browser behavior at narrow/wide sizes, fake downloads without installing, and independent Risk2 review | route: parent functional checks + gentle-ai-verify; pending; commit: pending.
- T5 | S1-S3 | Document publishing/configuration limits and expose actual functional preview, without claiming nonexistent releases | route: parent; pending; commit: pending.

## Log
- L1: "creala ya completa que funcione perfecto solo sea poner que se bajen los lanzadores y listo"
- L2: Earlier exact request: "muestrame la pagina que se lanzara para instalar?"; clarification: "los app se crean en los CIs de cada sistema operativo". Parent and configured explorer found no existing Dot installer web page or design. This authorizes implementation, not running installers or restarting exhausted native CI cycles.
- L3: Public GitHub latest-release API currently404; no public launcher assets verified. Existing six-target native workflow publishes QA-only14-day artifacts, releaseReadyfalse—not public download URLs. Use real GitHub Release assets only, display unavailable/error explicitly, never invent executable links or claim native/installed acceptance. Current producer suffixes: Windows-setup.exe; macOS.dmg; Linux.deb and optionalx64.pkg.tar.zst. Keep published-source362619c/Shell4.9/SDK1.5 intact.
- L4: Standalone static site avoids app UI/dependency churn. No new package acquisition, real installer execution, CI trigger, release publication or live hosting configuration is included. A browser preview may query public release metadata only; synthetic test downloads never execute binaries. Source adapters must reject unsafe/off-repository asset URLs and QA/draft/prerelease payloads.
- L5: gentle-design canvas is rooted at the primary workspace. New task-owned design artifacts may live there for viewing and be mirrored by exact-file copy into this feature worktree for commits; never modify existing primary WIP. Production site code lives only on the new feature branch. Design system tokens derive from packages/ui/src/styles.css:1-36. One design direction, not three redundant pages.
- L6: Authored forecast approximately700lines: passive design/token unit; release-adapter/tests/docs unit(~250); page/browser/docs unit(~350), each kept reviewable around400lines. No parallel writers: adapter/page are dependent deliveries of the same download behavior. Risk2 requires independent verification regardless of clone-local RDDoff; no native review or mode change requested. Browser tooling: existing primary @playwright/test metadata present; no browser availability or passing checks assumed yet.

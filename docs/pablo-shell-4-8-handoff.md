# PR263 + Shell 4.9 collaboration handoff

## Published Linux collaboration base

GitHub accepted `feat/stable-pablo-shell-4-8` at **`27f73fa403ff54d0458f2cf324c3e8d05bd9700c`** (normal push job12, exit0). Repository: [Gentleman-Programming/gentle-dot](https://github.com/Gentleman-Programming/gentle-dot/tree/feat/stable-pablo-shell-4-8). Independent `gh api` readback confirmed that exact SHA (job13, exit0). A documentation-only follow-up may advance the branch without changing this code base. No main/PR merge, app installation or Linux acceptance occurred. The branch name is historical: it contains Pablo's PR263 plus published Shell4.9.0 and retained SDK1.5.0.

The human explicitly selected **Desactivar RDD en este clon de Dot y publicar**. Native mode change confirmed off, decided by clone_local; global remains on. This applies to the publisher's entire Dot clone and all its worktrees until the human requests re-enablement. It does not change Cinlo's clone, other repositories or review consent; do not automatically re-enable. Existing test and independent-verifier evidence remains required and recorded.

## Current dependency update — Shell4.9 SOURCE verified

Source update commit: **`becf519ebc0e0bf803529fc62e0e75e6ab2a7895`**, parent01cead9, seven paths48insertions28deletions. Branch `feat/stable-pablo-shell-4-8` retains its historical name and all Pablo commits; the current dependency is4.9.0, not4.8. It is included in the confirmed published source base27f73fa. This dependency work unit, not the inherited19385-line/95-commit origin/main range, is the assessment/review slice.

The human subsequently requested **"y se debe subir la version a la nueva que salio"**, clarified as **"El Shell que incluye Dot"**. The current working candidate upgrades only Dot's `gentle-pi` dependency/lock to official published4.9.0 (sourcece64a9a708e50c0ca899c8023140e63f29f293e1), retaining SDK1.5.0 under unchanged optional peer requirements. SDK1.5.2 was investigated, not silently added. Existing production/custom-agent environment and no-provision guards are unchanged.

The focused public dependency/launcher contract observed RED against4.8 (1FAIL/3PASS/exit1), then GREEN after the pin/lock change (4PASS/0skip/exit0). Lock changes are limited to the selected version, resolved snapshot and official registry integrity; no dependency acquisition, lifecycle script, private fixture, compile or real engine session ran. `runtime-build.test.ts`'s expected version was updated but its artifact-building suite was not run. Independent Risk5 verifier `mwnrhzvv-c-dvtd` returned S3 MET/no new blocker, executing the four public contracts once (4PASS/0skip/exit0) and diffcheck0 without writes. New-candidate native assessment reports medium/reviewDuefalse; no START/consent/lineage/approval burn. The runtime acceptance limitations remain unchanged. Historical source evidence below remains4.8-only, not4.9 runtime acceptance. The separately authorized Shell timeout fix does not authorize modifying the installed runtime; source preparation is separate.

References below to `build/pr263-verification-01` and synthetic scratch are retained publisher-local evidence, not files shipped on this branch. A Linux recipient must prepare their own dependencies and isolated test state; do not copy Windows junctions, personal profiles or credentials.

## Historical4.8 outcome — source integrated, publication BLOCKED

Local source-integration commit: **`7e12bc54de1ab6c7be38cf7934c79f11b1a8e8aa`** on `feat/stable-pablo-shell-4-8`. Its two parents are290be77223aa910ec26635c2d85ab27834c9f776 and80c5a1d73cf69d2d706b4f36915172a7ed74e58a; all12 original PR commits remain in history. The merge includes the documented fixture-only Windows-home correction and handoff/task records. The exact290..7e12 slice has19paths1124diffLines; the19341lines/93commits origin/main advisory includes inherited work, not this review slice.

Committed-range assessment: native medium/reviewDuefalse/under-budget; Risk2 independent source verification MET. No native START, consent, lineage or approval burn. This is not platform acceptance.

**At this historical checkpoint, remote delivery had not happened.** The later explicit clone-local RDD decision and confirmed publication above supersede that status, not the native/platform proof limits. The foreground push was intercepted before execution because its bounded RDD preflight was cancelled/timed out. A supported inspect returned `operation_timeout`, `authority-unavailable`, actor unknown, mutation not started/authority not evaluated; no automatic retry. The human selected **Reintentar la comprobación nativa una vez**. That one fresh inspection returned the same timeout. Keep T4 blocked; do not retry, reset/rebuild authority, disable review, bypass the delivery path or offer a substitute transfer. No remote combined-branch identity is confirmed.

## Historical candidate identity — before local commit

- Branch: `feat/stable-pablo-shell-4-8`.
- Baseline/first parent: `290be77223aa910ec26635c2d85ab27834c9f776`.
- Reviewed PR263 head/pending second parent: `80c5a1d73cf69d2d706b4f36915172a7ed74e58a`.
- Merge base: `b04b6bfedc40aefd00c1206ee258d2cb1ede6939`.
- Parent performed the authorized `--no-ff --no-commit` merge successfully. No conflicts or manual resolutions; HEAD still names the baseline and MERGE_HEAD names the reviewed head. All 12 PabloGNU commits remain intact; no squash/cherry-pick. No merge commit or publication yet. **Final collaboration SHA and message remain parent-owned and pending verification/delivery.**

The original parent merge applied exactly the reviewed 17 paths (936 insertions, 42 deletions), matching the PR head on those paths. Shell 4.8 baseline changes remain alongside them. Parent subsequently staged documentation; the narrowly authorized fixture correction below is a later unstaged delta, not part of the original reviewed PR. The worker did not stage or unstage anything.

## Historical4.8 integrated-source evidence

| Layer | Observation | Limit |
| --- | --- | --- |
| Source/history | Reviewed diff applied unchanged; no unmerged entries. Public JSON/source assertions confirm `gentle-pi` 4.8.0, pi-ai/coding-agent/mcp/tui 1.5.0 and matching daemon lock importer. | Not execution of Shell or SDK. |
| Preservation | Root/daemon manifests, `pnpm-lock.yaml`, daemon `config.ts` and both Tauri identity configs are byte-unchanged from baseline via Git diff. No tracked root `package-lock.json` exists and none was created. Bundled-default interactive-host removal and both installed-Windows no-provision gates remain in `agentSpawnEnv`; custom-agent exclusions and shared-memory/loopback/4317 defaults remain. | Source inspection, not a new behavioral run of old source tests. |
| Whitespace | `git diff --check && git diff --cached --check`: exit 0, empty output. | Checks tracked diffs; not a functional check. |
| New-candidate source contracts | `node --test scripts/windows/test/preview-isolation.test.mjs scripts/windows/test/preview-frontend.test.mjs`: exit 0; 11 passed, 0 failed/skipped/cancelled. Sources audited first: built-in-only public source/config reads. | No daemon, Rust compilation, native ACL, WebView, provider, microphone or installed-app execution. |
| Focused admission behavior | Parent normal Vitest node project/global Go setup: **31 passed**, exit0, 29 other cases excluded by the name filter. Real source private-storage helper compilation ran; source setup/timeouts/assertions unchanged. | Fresh sealed synthetic state, no downloads or real accounts. Not a full60-case pass or native app acceptance. |
| Memory preservation and corrected fixture | Parent job3: **26 passed, 1 failed, 33 skipped**, exit1. Job4: exit0 but **zero selected/60 skipped**, NOT GREEN. After one runner-name mapping correction, job5: **1 passed, 0 failed, 59 filtered**, exit0, JSON selectedPassed1. | Original failed and zero-selection receipts retained. Together with job2:58 selected cases passed across three runs; two existing lsof-conditioned cases remain unrun, not a single60-case/full-native pass. |
| Functional/native limits | PowerShell7 is absent from PATH and the standard public installation paths, so the startup fixture was not run. Rust native ACL, real Shell RPC, app/installer and Linux qualification remain unrun. | Missing proof, not failed assertions or renewed historical acceptance. |

No fresh RED was required for applying the unchanged reviewed fixes. The later preservation-fixture correction has actual parent-observed job3 failure and job5 exact-case GREEN, recorded below; no base-runtime RED reproduction is claimed.

## Integration self-inspection (not independent review)

- **Fit/order:** shell validates preview identity/port/fresh root, exclusively creates and protects synthetic profile directories, then emits the preview marker before configuration/plugins. CLI calls `startDaemon`; Windows app-channel admission precedes preview listener lookup. Marked private-memory admission precedes directory protection/claims, provider discovery, token/home/workspace writes and supervisor startup.
- **Ownership:** existing listeners require matching stored/health identity and a repeated stable positive PID. Existing-listener admission carries an explicit wrapper with undefined cleanup, preventing fallback to a second permissive lookup. Only empty-port admission can acquire later cleanup, which still rechecks identity and PID. PID reuse after the last check remains a limitation.
- **Reuse/size:** native preview creation reuses TokenUser, descriptor and private-file helpers (`CREATE_NEW` for config); directory creation remains exclusive. PowerShell system-image selection is in the shared listener helper, including the 15-second Windows timeout; no duplicate integration helper was added.
- **Effects/QoL:** preview now fails closed on uncertain ownership (intentional refusal/lookup latency); unmarked production keeps its previous preparation/memory ordering and permissive decline-cleanup behavior. The shared system PowerShell lookup also affects production private-memory observation. Embedded frontend remains explicit `custom-protocol`, default features empty. The startup ACCEPTANCE-FIXTURE uses a fresh monotonic 30-second budget rather than 12 polls; existing installer smoke deadline remains untouched.
- **Balance:** FOR: preserves authored history and composes the reviewed preview protections with existing Shell guards, without dependency churn. AGAINST/remaining costs: marked startup adds health/PID observations and refusal paths; native ACL/ownership and shared lookup behavior still need candidate-bound proof. System maintenance is bounded to existing helpers; product/support must not advertise stable readiness from source tests. No additional refactor or removal is proposed.

Parent supplied the frozen PR/review/community context and integration authorization; no fresh remote search, approval disposition, independent review or delivery was performed by this worker.

## Existing runner/dependency map — pending commands, NOT authorization

The table below preserves the initial pre-projection runner audit. At that point root/daemon node_modules and the local Vitest entry were absent. Parent later created the seven verified public-library junctions and ran job2/job3 as recorded above; initial UNRUN rows do not supersede those actual results. Root requires Node >=24, pnpm 11.5.0, Vitest ^5.0.3; daemon runtime imports require its protocol workspace link, ws, exact SDK 1.5 siblings and transitive dependencies. Do not run a blanket install or acquire Gentle Pi fixtures containing private material.

| Existing entry / candidate command | Prerequisites and effects before a parent may authorize it |
| --- | --- |
| `node --test scripts/windows/test/preview-isolation.test.mjs scripts/windows/test/preview-frontend.test.mjs` | Observed pass above; no third-party dependencies or synthetic-state writes. Inherited runtime options/control bindings were left unchanged and unread. |
| `node node_modules/vitest/vitest.mjs run --project node packages/daemon/test/private-memory.test.ts -t "preview memory startup admission"` | **UNRUN.** Candidate-local compatible public dependencies required. Root `vitest.config.ts` node project always invokes `packages/daemon/test/windows-private-storage-global-setup.ts`; on Windows it calls `prepareWindowsPrivateStorageForSource`, which runs `go build` and writes `build/windows/local-tools/bin/private-storage.exe` (`runtime-build.ts`). This is the daemon global Go-setup requirement, not an existing bypassable option. Current scope authorizes neither compilation nor those generated paths. Admission cases mock downstream startup/listener/health/kill and snapshot fresh synthetic state, but module collection also probes `which lsof`, imports daemon runtime modules, and Windows `tempDir()` invokes native private storage before installing barriers. Fixtures do not remove their temp trees. A parent must qualify setup, scratch retention/cleanup and inherited-hook preservation before execution; do not disable global setup or assertions. |
| `node node_modules/vitest/vitest.mjs run --project node packages/daemon/test/private-memory.test.ts` | **UNRUN.** Same setup/dependencies; additionally launches synthetic HTTP listeners/fake agents and performs real listener enumeration/owned-PID cleanup in existing groups (Windows case permits 60 seconds; A4 group depends on lsof). Not a source-only substitute for the focused admission group. |
| `node --test scripts/windows/test/daemon-startup.test.mjs` | **UNRUN.** Requires fresh external `GENTLE_DOT_CI_TEST_ROOT` and exact public PowerShell 7 executable in `GENTLE_DOT_TEST_PWSH`; retains scratch with inert runtime placeholders. Tests dot-source the startup script, mock launch/clock/health, read smoke source and import smoke diagnostics; no real daemon/native compilation intended. Its explicit PowerShell child environment omits inherited NODE_OPTIONS/control bindings, and one case writes a synthetic NODE_OPTIONS value. Follow-up inert audit found no actual Node/application launch: placeholders are never executed, real start/owner adapters are mocked, native source is returned as text, and direct CLI exits at the non-CI gate. Omission of unused Node flags from PowerShell is not automatically guard weakening. Parent must validate its actual control context; no worker absence requirement, flag stripping or fixture change is authorized. PowerShell7 availability remains a separate gap. |
| `scripts/windows/test-daemon-startup.ps1` direct CI fixture | **UNRUN.** Needs separately authorized packaged runtime, native C# job adapter, loopback health and retained scratch; default scratch writes `build/arise-ci-t6`. Child environment is explicitly cleared. No real-runtime command is authorized or offered here. |
| Preview Rust/native fixtures and standalone frontend build | **UNRUN.** Existing instructions are in `docs/install.md`; require separately authorized qualified toolchains/dependencies, UI output and native generated-path scope. Some preview Rust fixtures retain system-temp trees. No Cargo/Go/build/download was run. |

## Historical4.8 independent source verification — MET

Verifier `mwnkwgap-7-sn40` inspected the entire specification, integrated source/call paths, baseline, fixture correction, helper/receipt/report claims and Git identities without changing files or executing functional cases. No confirmed source-integration blocker was found. At verification time the original17 PR paths were intact in the index; the separate fixture input correction was reviewed explicitly and retained assertions/production semantics. Both were subsequently included in source merge7e12bc5.

Native assessment reports medium/under-budget and no due native review; the explicit Risk2 escalation's independent-verifier requirement is satisfied for this bounded source gate. No native START, consent, lineage, approval or burn is claimed. Functional runs remain parent/worker-attributed, not independently executed. A first malformed read-only Git inspection in the verifier produced usage; the corrected command succeeded, not a product/test failure. Optional additional regression advice is not a correction requirement and was not implemented.

## Remaining risks and Cinlo boundaries

- **Risk 2 — native security proof pending:** independent SOURCE review of admission ordering, TokenUser creation, production preservation and listener identity/PID behavior was MET. Source contracts are not actual native ACL or installed-app boundary evidence.
- **Risk 3 — functional/native proof limits:**58 selected memory cases passed across parent jobs2/3/5, including corrected-case GREEN and normal global Go setup. Two existing lsof-conditioned cases, PS7 startup fixture, Rust native ACL, real Shell/runtime/ownership/quit/relaunch and platform acceptance remain unverified. Independent SOURCE verification was MET; native/platform acceptance remains pending. No historical budget was reset; R3-001 remains closed, not reopened by this map.
- The separate producer `installerEnv`/NODE_OPTIONS gap is untouched. Shell version source pins do not qualify an artifact, authorize app replacement, or resume installation/hardware/provider/model activity.
- **Cinlo L1:** Linux x64 desktop/daemon/native acceptance still needs candidate-bound execution and accepted I1 shared-isolation evidence. Windows preview source checks do not satisfy it.
- **L2:** depends on L1; producer/container observations are distinct from native disposable installation/update/removal and desktop launch.
- **I2:** after recipient acceptance and approved named shared-file handoffs, reconcile exact contributor deltas on the parent-delivered branch/SHA. This document grants no shared-file or main-merge authority.
- **I3:** remains pending a single exact candidate with I1, W1–W3, L1–L2, UI1–UI2 and I2 evidence; no release-ready/stable assertion follows here.
- **C5:** remains paused. Do not import the unrelated secret-file correction or run C5/typecheck/new CI. Its source correction 1/1 and auxiliary repair 1/1 remain consumed; no third preparation attempt or renewed proof. C4 remains after C5.

The shared source base is **27f73fa403ff54d0458f2cf324c3e8d05bd9700c**, containing merge7e12bc5 and Shell4.9 dependency commitbecf519. GitHub publication and independent API readback are confirmed. No message was sent.

## Message draft for Cinlo's Linux continuation

> Cinlo, ya está publicada la base con el PR de Pablo integrado y Shell 4.9.0, manteniendo SDK 1.5.0. Está en `Gentleman-Programming/gentle-dot`, rama `feat/stable-pablo-shell-4-8`, base de código `27f73fa`. Podés sacar tu rama de pruebas desde ahí y continuar con lo de Linux, sin pisar tus cambios actuales. Pasaron los contratos de fuente y la revisión independiente; las pruebas nativas/Linux y C5 no se dan por resueltas con esta publicación. El detalle está en `docs/pablo-shell-4-8-handoff.md`.

Draft only, not sent. To preserve an existing Linux checkout's work, fetch the explicit repository and create a separate worktree rather than resetting the current branch (choose fresh names if these already exist):

```sh
git fetch https://github.com/Gentleman-Programming/gentle-dot.git feat/stable-pablo-shell-4-8
git worktree add -b test/linux-pablo-shell-4-9 ../gentle-dot-linux-4-9 FETCH_HEAD
```

Continue only the previously authorized Linux activities and their existing dependency/approval boundaries; this does not reset C5 or any exhausted correction budget.

## Parent verification preparation and observation

Seven exact public-library junctions were created only in this integration worktree after target/version revalidation: no file copies and no host SDK4.9/1.5.2 substitution. The helper was corrected before execution to construct a Windows metadata/guard allowlist plus fresh synthetic home/cache/Go state; provider/proxy credentials are not inherited. Actual NODE_OPTIONS and recognized control text stay byte-unchanged, without disclosure or authority grant. The default global Go preparation was retained, with network/toolchain auto-acquisition disabled for this dependency-free helper.

`build/pr263-verification-01/admission-run.json` and parent job2 bind the actual31-case result. Synthetic scratch is retained under system temp; real user data and the installed runtime were not modified. Public installed SDK1.5 libraries were read-only references for tests, not shipped or certified as pristine artifacts. A separate preservation invocation has a fresh receipt/state and negative name filter, rather than rerunning the31 already-passing cases. The prior preparation-only rows describe the earlier boundary, not current claims.

## T2 verification preparation follow-up — not execution

Parent staged the two new Markdown documents only; reviewed source remains untouched. The new [bounded preparation](../build/pr263-verification-01/README.md) and `plan.json` derive **seven exact per-package junctions**: primary public Vitest5.0.3/Vite8.3.3/plugin-react6.1.2, candidate protocol0.1.0, installed-public ws8.22.0/pi-ai1.5.0/pi-mcp1.5.0. Seventeen distinct public package manifests were individually read; remaining observed pnpm dependency-link version labels are explicitly distinguished from manifest verification. No full node_modules copy/junction or library/CLI acquisition occurred; wrong primary SDK1.0.4 and host Shell4.9-main/SDK1.5.2 are excluded.

Inspected admission paths use lazy coding-agent/jiti/Shell imports only beyond the mocked barriers; no actual Shell4.8 module import is needed by those paths. Lazy-transform resolution and transitive/native loading remain unproved. Existing dependency closures resolve at their original public package realpaths, not through fabricated types/config overrides.

The prepared `parent-run-admission.ps1` validates already-authorized links and versions, preserves outer NODE_OPTIONS/control text without inspecting it, uses fresh external system-temp HOME/AppData/cache/Go outputs, and retains normal node-project globalSetup/timeouts/assertions. Parent must authorize projection destinations, Vite cache/config-bundle trees and `build/windows/local-tools/bin/private-storage.exe` before execution. Actual Go compilation is real and potentially long; parent may own the whole helper as a background job. Exact future command and effects are in the preparation README/JSON. No link creation, helper execution, package/Go/Rust/Vitest/runtime/version command or new native authority occurred here.

Observed once: PowerShell `Parser.ParseFile` of the new helper exited0, `PASS ParseFile errors=0 execution=0`. Current preparation `git diff --check` also exited0 with empty output. This is syntax/documentation evidence only, not PS7 readiness or functional proof. Startup fixture's PowerShell-only inert behavior corrects the earlier automatic environment-omission blocker; parent actual-context validation and PS7 availability remain separate prerequisites. T2 and risks2/3 stay pending; C5 limits/pauses and all prior failed evidence remain unchanged.

## Preservation failure and correction preparation — historical checkpoint before jobs4/5

Parent job3 is an actual failed check:26PASS/1FAIL/33skipped, native exit1; `build/pr263-verification-01/preservation-run.json` remains unchanged with failed/exit1 and confirmed process termination. Job2's31PASS/29filtered and real global Go compile success remain separate, not a full-suite pass. No original run is relabeled PASS.

Exact failing fullname: `the daemon's memory setting seam leaves an absent or shared setting on the user's global Engram`. Read-only raw-byte comparison against baseline290be77 proved the pre-fix case(452bytes), engineEnv wrapper(156), isolatedAgentEnv section(4695) and windowsUserHome section(471) identical. Full hashes and delimiters are in [shared-mode-cause.md](../build/pr263-verification-01/shared-mode-cause.md). No base runtime was executed.

Cause: fixture base supplied HOME only. Unchanged `isolation.ts:170` chooses Windows USERPROFILE/HOMEDRIVE+HOMEPATH via windowsUserHome, then homedir(); it does not use base.HOME on Windows. With no profile in the base object, received shared Engram path follows the parent's separate synthetic process USERPROFILE, explaining the observed mismatch. This predates PR263, not a new production regression.

One fixture correction adds `USERPROFILE: realHome` beside `HOME: realHome`, with a clarifying comment. All existing assertions/names/skips and production/profile precedence remain intact. No global USERPROFILE deletion or real-profile fallback, source/producer fix, C5 change or renewed historical budget.

Prepared `parent-run-shared-mode.ps1`, identical to the current parent-sealed admission helper except fresh create-new `shared-mode-run.json`, external `pr263-shared-mode-<GUID>` scratch and anchored exact-full-name filter. Its normal globalSetup/Go compile, timeouts, ProcessStartInfo allowlist and inherited actual NODE_OPTIONS/recognized controls are unchanged. Parent command, not executed by worker: `powershell.exe -NoLogo -NoProfile -NonInteractive -File build/pr263-verification-01/parent-run-shared-mode.ps1 -Node 'C:/Program Files/nodejs/node.exe'`. It selects only the failed case, not31+26 already-passing cases. Parser.ParseFile ran once: exit0, `PASS ParseFile errors=0 execution=0`, empty stderr. At this preparation checkpoint corrected-case GREEN was unobserved and T2 remained open. Jobs4/5 below supersede only that pending-proof status; the failed receipt and consumed fixture correction remain preserved. Rust/native app/ACL/installed/Linux and PS7 startup checks remain explicitly unrun/unavailable.

## Historical bounded source self-review — before T3 completion

Readback of both shared-mode helpers and actual receipts confirms:

- **Job4:** anchored full-name selector selected zero tests (60 skipped), despite exit0 and `shared-mode-run.json` recording state=pass. That receipt is retained verbatim but is **UNVERIFIED, not GREEN**; an exit-only check did not establish selection.
- **One parent runner-mapping correction:** v2 uses the unique existing leaf name `leaves an absent or shared setting on the user's global Engram`, fresh helper/receipt/scratch and a JSON reporter. The helper explicitly requires numPassedTests=1 and numFailedTests=0 before recording pass. No test/source/assertion/config/timeout/globalSetup/control policy changed for this mapping correction.
- **Job5:** `shared-mode-v2-run.json` records exit0, nativeTerminationConfirmed=true, selectedPassed1/selectedFailed0 and unchanged Node options/control text. `shared-mode-v2-vitest.json` confirms the intended full-name assertion passed,0failed/59pending. Normal global Go setup and sealed synthetic state remained enabled. No31+26 already-passing cases were rerun.
- **Aggregate:**31 admission +26 preservation +1 corrected shared-mode case = **58 selected cases passed across three runs**, with two existing lsof-conditioned cases unrun. Not a single60-case green suite, full platform validation or app-native acceptance. The11 previously observed source-contract passes are retained without replay. Original job3 assertion failure and job4 zero-selection remain evidence, not retroactive PASS.
- **Diff self-review:** only the pre-existing fixture's synthetic base gained USERPROFILE beside HOME plus a comment; exact assertions/name/skips and production/API/platform behavior remain unchanged. Raw-byte baseline causality evidence remains linked above. Source fixture correction1/1 is consumed; no historical S7/S8/C5 budget renewed. Authored PR history, Shell4.8/SDK1.5 pins, bundled-default refusal/no-provision gates and unrelated producer/C5 boundaries remain intact.

**At that historical checkpoint T2 was done for bounded collaboration-source integration/self-checks and T3 was pending. T3 subsequently returned MET as recorded above.** Rust native ACL/WebView, PS7 startup fixture, real Shell RPC, app/installer/device/provider and Linux qualification remain outside executed proof. No production/main merge, release, publication, final collaboration commit SHA or delivered-message fact is claimed. Parent records the final SHA after source verification.

Cinlo may resume separately authorized activities from `feat/stable-pablo-shell-4-8` once the parent confirms the exact collaboration SHA. That supplies a source baseline only: L1/L2/I2/I3 dependencies, named shared-file handoffs and C5 pause/consumed limits still apply. No blanket native acceptance, provider/device consent, C5 retry or message-sending authority follows.

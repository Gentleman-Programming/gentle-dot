# I1: original launcher and exhausted-limit evidence

**Read-only evidence attachment, not a corrected I1 candidate or permission to run.**
This completes PabloGNU's forwarded 13:26 request for the missing post-S7/S8 stop record and original launcher identity evidence. No ownership reconfirmation, implementation, tests or CI is requested here. Pablo's `95e2cf3` remains author-reported, unavailable locally and not read for this packet.

## Original source, not a runnable bundle

- [Original launcher plaintext](open.mjs.txt): 172 lines, 11,834 bytes.
- [Original observer plaintext](observe.ps1.txt): 56 lines, 3,935 bytes.
- Both are unaltered byte-exact `.txt` snapshots, with no added header or code fix. Do not execute, import, syntax-check or rename them for launch.
- Retained source locations, repository-relative to the original same-clone `pr-232-233-full` worktree: `build/pr-preview-open/open.mjs` and `build/pr-preview-open/observe.ps1`.
- The launcher requires its original `build/pr-preview-open/manifest.json`, observer and `build/pr-preview-native-check-s8/common.mjs`, plus sealed source/receipts, qualified runtime artifacts and original local prerequisites. It is not self-contained; not all original artifacts are in Git, and local runtime prerequisites are **not transported**.
- Raw manifest, HANDOFF and ownership receipt are intentionally omitted because they contain private absolute paths. No environment/profile/database/credential content or binaries are attached. Public Windows/tool installation literals in the original source are retained, not private profile paths.

## Identity: fresh source rehash versus recorded artifacts

SHA256 values below distinguish fresh attachment checks from historical artifact evidence. No real binary was rehashed or executed for this packet; release-asset provenance is not a publisher signature.

| Source | Recorded manifest source seal | Fresh source and destination SHA256 |
| --- | --- | --- |
| `open.mjs` | `006469774528a62970970447a9b9a32530a4a191ef918ee73fc355d4d4c70213` | `006469774528a62970970447a9b9a32530a4a191ef918ee73fc355d4d4c70213` |
| `observe.ps1` | `2523dc0d3243df864c8f9ea22859164fed06db4a2585eed285d687907ac7b96b` | `2523dc0d3243df864c8f9ea22859164fed06db4a2585eed285d687907ac7b96b` |

Fresh source/destination checks match both recorded seals: **no drift**; existing seals were not rewritten.

| Recorded artifact identity | Bytes | Recorded SHA256 / provenance |
| --- | ---: | --- |
| Engram executable | 21,736,448 | `c2bca1167cad86c7618fd03b8ca3bdfc52df072da600593612edece3cf25f8ab` |
| `engram_3.4.0_windows_amd64.zip` | 8,021,225 | `3065736ec7ff8137eb3fc607275f542ea13bb743a5157318c8a8770f11ce3289`; public v3.4.0 release asset |
| Preview `gentle-dot.exe`, PE AMD64 | 30,243,328 | `bd0d206599d80f96186d361147385919d0e6db8243b4d683443eb5270f579349`; app identity `dev.gentleman.gentle-dot.preview` |

The original manifest supplied the archive digest as the EXE pin. `open.mjs:89` rejects unequal supplied/qualified pins before the single-use latch (`:96`) and spawn (`:130`). This is static control-flow evidence, **not an executed refusal**. Prior launcher preparation was syntax-only; no launch attempt was made.

## Chronological stop record: original integration S7/S8 only

Source for the following bounded excerpts: retained original `odd/tasks/pr-232-233-integration.md`, not this branch's stable tracker. Its S7/S8 are different work units from [stable-integration S8/C5](../../../odd/tasks/stable-integration.md#specs), the paused test-import correction. These excerpts grant no C5 action or new I1 budget.

1. Original S7 authorization: **"Build preview aislada en esta cuenta (recomendado)"** — one source correction round for isolated preview identity/synthetic credentials, preserving production defaults. Original L56 records the used round: **"S7correction1/1EXHAUSTED."** L58 records the corrected native build, not app activation: **"S7source1/1exhausted,nofurthercodefix. No Appactivation/nativeacceptance."** This worker-local source limit is not a native review-context limit.
2. Original S8 authorization: **"Sí: adaptar solo el test y verificar"**. L67 bounds it to `windows_process.rs`: **"Una corrección test-only; compilación nueva y seis casos nativos. Conserva todos los fallos y límites anteriores."** L68 records **"S8ONE1/1EXHAUSTED,NOcompile/tests/GREENclaimbywriter."** It was not an isolation-code grant. Subsequent compilation passed; two Rust cases passed, but wrapper admission failed on valid orderly-stop stderr. Later Node completion passed four required cases across retained attempts, not one fresh six-case sweep; none of this renews source correction authority.
3. Latest original L79 stop: **"S7/S8/oldsourcebudgetsremainexhausted. T3BLOCKEDnewhumanboundedpreview-onlystartupisolation scope (rejectforeign/ambiguousmemory beforeengine, tests/build/independentproof) orhumanstop; no newsourcebudget/implementationauthorizedyet."** L80 confirms **"Newpreview-onlysourceauthorizationstillrequired; T3BLOCKED/oldbudgetsunchanged."** No app was started by launch preparation.

### Separate native-review boundary

Original L26 records the full PR233 candidate stop: **"preflightSTOP lens_context_budget_exceeded,mutationnone/noauthoritycreated."** The offered lineage was never created/bound. This is a candidate-context stop, not a source-correction budget; do not retry/reset it or infer approval.
The later reduced preview `80baa1d` and CI `375b3f5` source authorities were approved, acknowledged and consumed ([stable tracker L20–L21](../../../odd/tasks/stable-integration.md#log)). They must never be reused; those approvals are not runtime/I1 acceptance.

## Why I1 remains open

- Original L79–L80 identify `packages/daemon/src/isolation.ts:274–304`: occupied or ambiguous private-memory startup can return normally without preventive ownership refusal, allowing engine startup to continue. Cleanup identity checks are not startup admission proof.
- Launcher reservations are released at `open.mjs:128` before spawn at `:130`; foreign-memory checks at `:142,149` are post-spawn. They cannot prove preventive refusal before initial contact. The real source gap is occupied/ambiguous fail-open startup, not a demand for mathematically race-free ports.
- This is a **source gap, not observed foreign contact, a privacy breach or a newly demonstrated regression**. Missing proof includes preventive startup refusal, owned memory, effective WebView profile, visible UI and voice; prior component checks do not supply it.

## Recipient disposition

Read the original inert source and this stop/identity record alongside the [I1 card](../../stable-integration-handoff.md#i1--preview-isolation-and-launcher-identity). The human disposition remains a newly bounded preview-only startup-isolation authorization under the existing limits, or stop. This attachment does not grant either execution or an automatic budget/third attempt/reset, and changing executor cannot bypass limits.
No memory deletion, import, global-memory rewrite, private-state inspection, provider/device use, launch, new CI or product acceptance follows from receiving this packet. Existing owners/proposals and pauses remain unchanged.

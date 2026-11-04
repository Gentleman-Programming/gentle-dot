# Distribution contracts

**Decision:** Gentle Dot owns its desktop product and ships a private, versioned assistant runtime. Consume a tested Gentle Shell/Pi combination; do not extract a shared core or replace the user's global tools by default.

This is an adopted architecture and documentation convention, **not a completed packaging migration or a release-readiness claim**.

## Ownership

| Component | Owner and boundary |
| --- | --- |
| App, UI, daemon, native permissions and Stop | Dot. Keep desktop integration and session enforcement here. |
| Shell/Pi runtime | Consume the compatible Shell release recipe, dependency lock and installed artifact identities as one tested unit. Keep Dot's installation private. |
| Gentle AI authority and review contracts | Consume the canonical upstream implementation and contracts. Reference them; do not maintain a Dot copy of authority prompts, verdict rules or recovery machinery. |
| Engram executable | Version and verify the binary independently of the data it reads. |
| Engram databases, sessions and credentials | User data, outside replaceable runtime/component directories. A binary update is not data-migration authorization. |
| Optional eyes/hands providers | Target-specific, versioned components with their own source, license, full-payload identities and lifecycle proof. Readiness is not session permission. |

Logical ownership does not require a new repository, extraction or a second upstream release pipeline. Each repository keeps its own contributor and release policy; do not import an approval label or workflow just because another ecosystem repository uses it.

## What exists, and what remains planned

| Evidence in this checkout | Limit |
| --- | --- |
| [Daemon configuration](../packages/daemon/src/config.ts) launches `gentle-pi/bin/gentle-shell.mjs` from the runtime and gives the assistant its own home. | Not a new runtime upgrade or proof of installed behavior. |
| [Runtime staging](../scripts/package/stage-runtime.mjs) writes `MANIFEST.json`, installs production dependencies through npm and records resolved Shell/Pi/Gentle AI versions. | The staging install does not consume a frozen release dependency lock. Postinstall behavior is part of the effective build input. |
| Staging chooses Engram from an explicit version, an installed version with an available release, or latest. | An implicit installed/latest choice is not the selected deterministic release recipe. |
| [Target helpers](../scripts/package/lib.mjs) enumerate `darwin-arm64`, `linux-arm64` and `linux-x64` and refuse a mismatched staging host. | This does not establish Windows support in that staging path, nor a fresh macOS/Linux runtime qualification. |
| [Windows packaging](../scripts/windows/package.ps1) has its own entry point. [Provider preparation](windows-computer-providers.md) documents fixed Windows pins and private cache checks. | Do not equate these source paths or static artifact checks with complete acquisition, native activation, installed-app or physical Stop acceptance. |

The selected frozen recipe, compatible runtime replacement and rollback gates below are **requirements for later implementation**. This documentation change does not implement them. Preserve existing macOS/Linux behavior when that implementation is authorized.

## Unit of compatibility

Treat a release as a tested tuple: Dot source revision and target; Node; Shell/Pi and its lock; Gentle AI; Engram binary; and selected optional providers. Never resolve these independently to arbitrary latest versions during a release build.

For each target, record the exact resolved versions and immutable source/artifact identities, not only a range or a tag. Reuse the supported Shell release recipe instead of substituting a newer standalone Pi. An exception needs an explicit compatibility decision and verification of the resulting tuple.

Do not copy the user's CLI installation, package-manager profile or credentials into the application runtime. Private runtime and private assistant home are separate from the user's existing global installations.

## Release evidence contract

Maintain one target-specific record, using the producer's existing manifest formats where possible. The following is a checklist, not a new implemented JSON schema:

- Dot revision, clean/dirty input status, OS/architecture and build toolchain.
- Exact Node, Shell/Pi, Gentle AI and Engram versions; source commits; recipe/lock identities; dependency and postinstall inputs.
- Every distributable component's producer, source revision, archive size, SHA-256, license/notices and complete-payload verification identity.
- What was built, checked, installed and exercised, including exact commands, exit codes and bounded stdout/stderr evidence. Keep failed attempts and distinguish them from successful runs.
- Platform-specific compatibility results and all missing, failed or skipped checks. A Linux or macOS result is not Windows proof.
- Previous known-good artifact identity, replacement boundary and tested binary rollback procedure; explicit data/schema compatibility and separately authorized migration, if needed.

A checksum establishes byte identity against its expected value. A manifest or checksum obtained with the artifact is **not a publisher signature** and does not by itself establish trusted origin. Name the actual trust/provenance evidence and its limits.

## Change and rollback gates

1. Map the component and target to its owner. Read the current source and producer recipe before proposing a replacement.
2. Freeze the compatible tuple and full-payload identities. Refuse unsupported targets, missing lock/provenance or an invented unpublished release URL.
3. Verify in isolated, authorized state. Do not launch a provider, installer, migration or desktop action merely to validate documentation or a pin.
4. Separate replaceable binaries from user data. Retain the previous known-good runtime; plan version selection and rollback before activation. Never imply a binary rollback reverses an irreversible data migration.
5. Report evidence at its real boundary. Source inspection, static artifact checks, fake-transport tests, native runtime checks and installed acceptance are distinct results. Native review is an additional outside view, not functional proof or permission to publish.

For the currently unpublished Dot-only hands variant, keep its local provenance and exact identity. Do not fall back to upstream blue hands or fabricate a download URL. The hands provider owns its indicator; Dot owns session consent and visible effective Stop. See [Windows provider status](windows-computer-providers.md) and [dispatch proof limits](windows-inputcontrol-dispatch.md).

## Documentation and the project skill

Lead with the decision and ownership boundary, then current evidence, gaps and the next gate. Keep one canonical reference rather than duplicating ecosystem rules. Label statements **implemented**, **verified**, **planned** or **claimed**, with an identifiable source and verification scope; those labels are not interchangeable.

Use [the project skill](../.agents/skills/gentle-dot-distribution/SKILL.md) for Dot packaging, runtime-update and release-documentation work. Its short instructions route agents to this document and local supporting references. It does not grant installation, migration, desktop-control, publishing or native-review consent.

Pi discovers `.agents/skills/gentle-dot-distribution/SKILL.md` as a project resource after project trust and reload. It can then be invoked as `/skill:gentle-dot-distribution` when skill commands are enabled. Creating the file does not prove that an already-running session reloaded it. Project trust controls resource loading; it is not an operating-system sandbox. No global package or settings update is required.

## Source snapshots

The comparison used these immutable upstream snapshots, not a claim that every main-branch feature is released:

- [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai/tree/3ea08cdfbdce671053c82377a4365915799abe57): canonical authority implementation and [LLM-first skill style](https://github.com/Gentleman-Programming/gentle-ai/blob/3ea08cdfbdce671053c82377a4365915799abe57/docs/skill-style-guide.md).
- [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell/tree/81e83ea6321dcca7c7bafe98364279c38b4082b3): compatible distribution recipe and runtime ownership evidence.
- Dot's current source links above: behavior was inspected, not executed by this documentation work. Reconcile them with source when packaging changes.

[Dot #178](https://github.com/Gentleman-Programming/gentle-dot/issues/178) is a separate Windows reconciliation proposal covering Spanish UI, legacy-store migration and packaging compatibility. Accepting it for planning does not approve a 298-file contribution, migrate existing profiles or establish its explicitly missing native-build and runtime checks. [RFC #147](https://github.com/Gentleman-Programming/gentle-dot/issues/147) is architectural context, not the requested acceptance target.

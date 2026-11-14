# Native review: a lineage stops being routable when the candidate tree is replaced

**Status:** open defect, documented with evidence. Lineage left in place (no authority was
consumed or mutated). Corrections themselves were verified and are in `main`.

**Date:** 2026-11-04
**Lineage:** `review-4fe612023d7b30da`
**Candidate:** `docs/profiles/nan-profiles.json` (5 paths, 257 changed lines, risk `medium`,
4 lenses, 3 blocking findings)

## What was observed

1. The review ran to completion: 4 lenses plus a refuter, 5 admitted role results, 3
   `BLOCKER` findings, all candidate-caused and all valid.
2. The findings were real and are now fixed in `main` (`6c1ab9d`): every one of the 39
   roles points at `nan/deepseek-v4-flash`, the doubled `nan/glm5.3-flash-flash` variant
   is gone, and the retired ids (`qwen3.8-flash`, `mimo-v2.6-flash`, `gemma4`) plus the
   quota-exhausted `glm5.3-flash` were removed.
3. Registering that correction through the native route was rejected on every attempt
   with `collectBinding is missing or stale for current STATUS`, including after the
   working tree was restored to the exact frozen candidate.
4. The tree is currently in `correction_required`. No acknowledgement happened, so the
   approved authority was never consumed: nothing was mutated by the bridge.

## Evidence from the durable record

`.git/gentle-ai/review-transactions/v2/review-4fe612023d7b30da/review-state.json`:

| Field | Value |
| --- | --- |
| `state.state` | `correction_required` |
| record `revision` | `sha256:c31d7598…` |
| `state.capture_phase_revision` | `sha256:531d587f…` |
| `state.current_snapshot.identity` | `sha256:20765b77…` |
| `state.initial_snapshot.identity` | `sha256:20765b77…` (identical: the tree was restored) |
| `state.current_snapshot.base_tree` | `bf255dad…` |
| `state.current_snapshot.candidate_tree` | `da997e0f…` |
| `state.correction_budget` | 129 (policy `floor_two`) |
| `state.fix_finding_ids` | 3 |

## Root cause

The reported symptom (`STATUS` reports `c31d7598…`, the correction binding asks for
`531d587f…`) is a symptom, not the cause.

Asking the facade for `STATUS` **with the explicit lineage id** does not return that
lineage's state. It projects the **current workspace** instead:

```
applicability: "unrelated"
target_identity: sha256:de608757…      <- the clean workspace, not 20765b77…
paths: []  candidates: []
next_transition: collect / empty_candidate_base_ref_required
```

So the correction route can never be offered: the projection describes a different
target (an empty candidate) than the one the lineage is bound to (`20765b77…`, the frozen
candidate snapshot). The previously issued binding is therefore stale, exactly as the
rejection says.

The lineage becomes unreachable as soon as the working tree no longer reproduces the
frozen candidate — which is unavoidable when the fix for the findings is committed
directly instead of going through the correction route.

## Expected behaviour

`STATUS` with an explicit `lineageId` should either

- return that lineage's own state (`correction_required`) with a currently valid
  continuation, or
- return a typed stop that names the divergence (`target_identity_changed`), so the caller
  knows the lineage exists but can no longer be routed, and can choose the audited
  disposition.

Reporting `unrelated` with an empty candidate silently erases a live lineage from the
caller's point of view, and the only remaining option becomes an `abandon`.

## Provider version gap (blocking, found after the candidate was reproduced)

The recipe below was executed: a temporary commit on the recorded base tree plus the frozen
candidate content for the five paths reproduced the snapshot exactly.

```
base_tree:              bf255dad…   ✓ matches the record
initial_review_tree:    da997e0f…
current_candidate_tree: da997e0f…   ✓ the frozen candidate
paths:                  5           ✓
requested_lineage_id:   review-4fe612023d7b30da   ✓ echoed back
```

The projection is no longer `unrelated`, but `STATUS` now refuses at a lower layer:

```
applicability: "corrupted"
action: "repair_authority"
next_transition: stop / corrupted_or_unverifiable_authority
repair: status "unsupported", compact_lineages 4, unsupported_lineages 4,
        eligible_candidates 0, conflicts 0
```

Every compact lineage in this clone is reported unsupported, not only the newest one, and
all four records share the same shape (`{revision, schema, state}`, no integrity field), so
the store is not malformed in any way we can observe. The decisive difference is the binary:

| Who | Provider |
| --- | --- |
| The session that ran the review | `gentle-ai 4.3.1` (`.gentle-shell` runtime) |
| The facade answering this session | `gentle-ai 4.0.0` (desktop runtime bundle) |

A 4.0.0 provider cannot verify authority written by 4.3.1, so the terminal stop is a version
gap rather than a corrupt store. Two stale zero-byte locks were moved aside during the
investigation (`*.stale-*`); they were not the cause.

**Consequence**: this cycle cannot be closed from a 4.0.0 session. Close it from a session
running 4.3.1 or newer (or after the planned runtime upgrade), or record the residue.

## Reversible closing recipe (executed; reuse after the upgrade)

Prerequisites: no other session holds uncommitted work in the same worktree.

1. `git checkout --detach bf255dad…` (the lineage's base tree).
2. `git checkout da997e0f… -- <the 5 paths>`: the frozen candidate as working-tree
   changes, no commit.
3. `gentle_review status` with the lineage id. A matching target identity should surface
   `correction_required` with a fresh binding.
4. Submit the correction (the fix already in `6c1ab9d`), then validate and acknowledge.
5. `git checkout main`, verify the tree is clean.

Every step is reversible; no commit, branch or reset is involved.

## Prevention

- Do not commit a fix for reviewed findings before the native correction route admitted
  it: a direct commit is what changes the candidate tree out from under the lineage.
- If the correction route is broken, treat the lineage as needing an audited disposition
  (or a provider fix) rather than routing the fix around it.

## Residue observed

- `.git/gentle-ai/REVIEW-MAINTENANCE.lock` and
  `.git/gentle-ai/review-transactions/v2/LOCK`, both zero bytes, created around the last
  rejected attempt. Neither was removed.

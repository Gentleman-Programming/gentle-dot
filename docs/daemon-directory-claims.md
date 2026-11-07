# Guarded daemon directory claims

This foundation provides `claimDaemonDirs` for explicit, authorized private
coordination directories. Daemon startup wiring is a separate change. It does
not select, create or harden a user's shared SDK home on the caller's behalf.

## Ownership protocol

- Each directory uses `.gentle-dot-daemon.lock` and the temporary directory
  `.gentle-dot-daemon.lock.guard`.
- Nonrecursive `mkdir` acquires the guard exclusively. All cooperating claim
  creation, stale recovery and release paths use that same guard.
- New records are `gentle-dot-daemon <pid> <32-lowercase-hex-nonce>` plus newline.
  Strict legacy PID-only records are accepted for liveness, not as release capabilities.
- Live owners, uncertain liveness and empty or malformed records are retained.
  Only a well-formed, provably dead owner can be recovered while holding guard.
- Release compares the exact nonce-bound record, not just a possibly reused PID.
  It is idempotent after success. Failed releases retain pending ownership and report errors.
- Directory operations remain within the supplied synchronous `EngineAccess`.
  Skipped/deferred contexts cannot acknowledge acquisition or release. Do not inject asynchronous I/O.

Existing private Windows parents are verified through a fresh missing-file
probe after checking the directory exists; they are not silently hardened.
New authorized directories and acquired guards use existing private-storage
helpers. POSIX checks use the effective user, including inside server-mode
access brackets. Canonical private-directory aliases are deduplicated.

## Recovery and limits

An existing guard is never reclaimed by age, PID or contents. A crash inside the
brief critical section may leave it behind and requires manual intervention.
First stop every relevant daemon and confirm its resources have stopped; inspect
the exact path in the diagnostic. Remove only a verified abandoned, empty guard.
Never recursively delete coordination directories or remove a live claim to force startup.

The caller releases leases only after its owned resources stop. Protection or
cleanup failures can leave diagnostic artifacts; both original and cleanup
errors are preserved rather than claiming a clean release. PID reuse may cause
a conservative refusal. Old clients that ignore guards, or users manually
modifying active claims, are outside the cooperative exclusion guarantee.

Injected contention and synthetic Windows helper-order checks are not evidence
of native Windows ACL/process behavior, installer acceptance or CI approval.

## Unwired startup admission coordinator

`claimDaemonAdmission` is available but **not connected to daemon startup**.
It first leases `.gentle-dot-daemon-claims` under the engine's effective OS
account home (`userInfo`, inside synchronous `EngineAccess`, not environment
home variables). It retains the legacy private dataDir lease and routes both
dataDir and SDK-home physical device/inode identities through that same private
registry. Registry overlap, unresolved aliases and unsupported identities fail
closed. Only typed startup-owner contention receives bounded retries; no guard
is automatically removed. SDK-only paths receive no coordination files or hardening.
A directory explicitly configured as dataDir still receives its private dataDir lease,
even when the caller also selects that same directory as its SDK home.

Accessible existing SDK-home and dataDir identities are fine-claimed **before**
contender dataDir filesystem effects, including cross-role collisions. Own equal
physical identities are claimed once; the legacy dataDir lease is still required.
A missing home stays untouched and retains the coarse startup-owner lease.

The optional synchronous `prepareOwnedDataDir(): undefined` hook is for the
caller's **unchanged ordinary owned-dataDir layout only**, never SDK setup. It
runs once outside EngineAccess, after coarse startup ownership, exclusive legacy
dataDir ownership and its physical fine lease. Only engine `EACCES`/`EPERM` on a
strictly dataDir-contained SDK path may defer initial SDK inspection until this
hook; accessible conflicts still reject before layout. DataDir/registry boundary
checks are never deferred. Hidden SDK aliases are not presumed safe or assigned
an identity: strict engine-side SDK/metadata checks must pass after layout before
admission returns. Continued denial, unresolved aliases and hook errors roll back
own acquisition; rollback failures preserve both errors and pending artifacts.
The hook must return `undefined`, not a promise, and may not start resources.
This staging changes no actual VPS permission policy or helper implementation.

The future lifecycle caller must:

1. Perform only its ordinary home creation/configuration, under engine access.
2. Call synchronous `promoteHome()` before SDK spawn, then `assertCurrent()`
   before subsequent ordinary spawn preparation. Promotion binds the actual new
   directory, not a guessed missing-path identity, and releases the coarse lease.
3. On promotion/assertion failure, stop owned resources **before** explicit
   `release()`. Failures retain ownership; failed releases need an explicit retry.

Until lifecycle wiring and its independent verification land, this API provides
no startup protection. Updated controllers cooperate only with other updated
controllers: stop older controllers before a mixed-version rollout involving
shared SDK homes. Legacy dataDir protection remains, but cannot make older
controllers participate in the new shared-home namespace. No additional SDK
commands, process killing, profile-lock rewrites or native-platform proof are implied.

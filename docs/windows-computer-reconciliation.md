# Windows computer/UI reconciliation

## Scope and outcome

The current source composes retained Windows behavior with the selected upstream's
permission, panic-shortcut and capture-coordination interfaces. This is **not**
installed-app acceptance, full-app approval, native review authority, or production
long-path support. Results below describe earlier retained source and must not be
used as verification of the current integration.

## Reconciled contracts

- `computer::win32::WindowsDesktop` remains active through the existing Windows app adapter. Accepted Word/Chrome/UIA behavior is retained as source, not re-certified by these checks. Verified-running-app activation, no cold launch/cross-app drag, exact UIA/runtime identity/default/risk checks, integrity/session checks, owned-window capture preparation, visibility intent and Hide safeguards remain.
- The active backend is the retained `computer::win32::WindowsDesktop`; only consumed target helpers remain in `computer::win`, not a second input/capture/app-launch backend. `alert::WindowChange` remains canonical. The active capture now checks the same change generation, including an alert that opens and closes between visibility fences, without removing its existing own-window checks. Unknown/old Windows build or unavailable composition fails closed.
- Upstream shared-helper safety remains: latest-screenshot recipient, per-chunk/key recipient rechecks, partial-typing error accounting, restoration after confirmation, Stop and rate/permission/session/blocklist/risk ordering. `post_typed` is forwarded through the app's existing flight/epoch/Working/visibility fences to the active backend. A recipient recheck cannot replace the focus metadata assessed before confirmation. Native posting still revalidates that original HWND/app/runtime identity and risk metadata.
- The upstream Windows blocklist handles both executable leaves and the active backend's `win32:absolute-path` identifiers. LockApp is also refused by the native exact-executable guard. macOS/Linux platform selection and native backend paths are not changed.
- Native UI replies require explicit `screenshotsSupported: true`; absence, false or malformed support cannot become readiness. Native invocation failures still reject. Registration, current prerequisites, session consent and Yolo remain separate.
- English/Spanish localization, platform-specific PC/Mac/unknown guidance, countdown/Stop and existing capability-based connector visibility remain. The upstream Windows screenshot warning and browser/server access-key instructions are localized. Native/backend strings remain raw. Expanded server guidance has its own message key; the original missing-token alias/value is preserved. Flattened native replies retain `panicShortcut` and finite `screenshotsUnsupported` reasons. The UI promises the shortcut only after explicit native registration.
- Memory preferences and device settings remain visible on Windows; the macOS speech-language section is hidden there, not duplicated. Device capability/voice-routing implementations and saved preferences are untouched.

## Historical observed validation

All test processes used isolated `HOME`, `TMPDIR`, `XDG_CACHE_HOME` and `XDG_CONFIG_HOME` beneath a local verification directory, explicit 30-second timeouts, no network/native probes and no real user state. Local verification artifacts are not distributed. Vitest was the checkout's **5.0.3**, not the old root graph. Native config loading and disabled cache avoid generated runner configuration/cache in installed dependencies; no runner/config file was changed.

1. `node --test packages/ui/test/computer-binding.node-test.mjs`: initial exit 1 before discovery (`ERR_INVALID_TYPESCRIPT_SYNTAX` in conflicted `computer.ts`). This was initialization failure, **not RED**; no unchanged-input replay or workaround.
2. After source conflict removal, same command: exit 1, 4 pass/1 fail. The requested regression observed missing `screenshotsSupported` instead of `false`.
3. After normalization, same command: exit 0, **5/5 pass**, including explicit true/false/missing/malformed support, endpoint registration, native session/Yolo/Stop authority, propagated failure and web no-op behavior.
4. `node node_modules/vitest/vitest.mjs run --project ui --configLoader native --no-cache packages/ui/test/i18n-computer-dot.test.tsx packages/ui/test/settings.test.tsx packages/ui/test/computer.test.tsx packages/ui/test/dot.test.tsx`: exit 1, 91 pass/4 fail. Three upstream-copy assertions expected permission-free readiness guidance/short PC wording instead of the retained prerequisite guidance; one exposed missing upstream server-link guidance. Tests were reconciled to the retained guidance (including recheck/no grant), and server guidance was restored bilingually.
5. Same Vitest command with `packages/ui/test/i18n-chat.test.tsx` appended: exit 0, **114/114 pass**, 5 files, 5.77 seconds. Includes new Windows Dot/localized unsupported-screenshot/device-memory/no-duplicate-language checks and existing Mac, session, registration, keyboard/pointer, memory/shortcut, locale and Hide behavior.
6. Scoped `git diff --check`: exit 0. Source marker scan of the seven formerly conflicted files: no markers. Their Git index entries remain unmerged until the parent stages them; this writer did not stage anything.

Strict TDD lifecycle was not activated. The observed regression failure/pass above is reported separately, without treating the initial parser failure as RED/GREEN.

## Unavailable checks and parent integration

`cargo` and `rustc` are absent on this host. Rust/native tests were **not executed**. Pure/injected fixtures were added for recipient binding, preserving assessed facts on successful recipient rechecks and invalidating on failure, typed refusal forwarding and unchanged pointer forwarding, blocklist identifier compatibility, and LockApp refusal. Existing upstream capture-generation/build-gate and shared-helper fixtures remain. Do not run the upstream Windows tests wholesale under a pure-fixture authorization: some query native windows/build/input state.

Current native composition preserves the existing `windows` and `windows-sys`
versions with the consumed feature union; duplicate dependency declarations have
been resolved without a lockfile re-resolution. Preserve native command/module registration, `alert::WindowChange`, active `windows_app` startup, and protocol exports. No additional public UI or protocol API is needed; `ComputerPermissions.screenshotsSupported` remains required, and the existing upstream `Desktop::post_typed` seam is now wired through the active adapter. Three capture helpers are computer-module-visible only.

### Risk / remaining gaps

Windows compilation, pure Rust fixtures, full integration, live native behavior,
new installed English/Spanish acceptance and independent native review remain
pending for the current source. Recorded-launch/channel ownership, checked cleanup,
DPAPI publication/migration, saved preferences and capture authority must retain
their existing contracts. No credential/profile/app/audio/input/capture probes or
review-authority operations establish acceptance here.

Earlier per-writer byte-level handoff records remain private. They are not hashes
of the current composed source and are not review approval.

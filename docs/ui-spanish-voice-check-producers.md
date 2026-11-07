# Hook-owned voice-check notices

The existing check observer accepts optional renderer-only display provenance.
Its raw `CheckState.note`, diagnostic correlation, generation, leases and callbacks
remain unchanged. Only identified `VoiceFailure` origins and explicit hook
callbacks carry a marker; plain strings/Errors, empty reasons and English
collisions remain raw. Known runtime/native recording origins and availability
origins reuse the existing display map. There is no text matching.

Input-busy/unavailable, output mute-read/muted/busy, stopped input/output, input
deadline and cleanup fallback copy is bilingual. The spoken phrase remains
`Hello, this is the Gentle Dot voice output check.`; no automatic playback or
new device/permission/persistence operation was introduced.

## Ordering deliberately preserved

A deadline cancels the existing capture. Its cancellation first reports
`Input check stopped. Nothing was sent to chat.`; subsequent deadline/cleanup
callbacks are ignored by the existing controller generation. Tests pin both
callbacks and that final raw state rather than changing this behavior. Likewise,
synchronous fake-recorder onstop retirement and cancel's explicit retirement
both stop the fake track, as before. No timer/cancellation repair is claimed.

## Historical verification and current limitations

These results belong to earlier retained source, not the current integration.
Joined renderer, typing, build and browser checks remain pending.

Corrected RED: eleven missing-Spanish/metadata failures and 60 existing passes.
Initial wrong-label/mock-retirement fixture failures and the new test's wrong
one-stop expectation remain in evidence; only those fixtures were corrected.
Final 114 renderer tests/four files and 38 pure routing/controller Node tests
pass; strict current main/useVoice/changed-test TypeScript passes with empty
streams. Tests cover all nine hook origins, carried runtime/native provenance,
raw native source collisions/empty/sentinels, unchanged capture retirement,
no chat sends and exact mocked IPC calls. The reason-less source fallback uses
a bounded pure-route fixture, not real hardware.

Fresh LSP confirms four selected D paths clean but reports ten contradictory
old-dependency arity/key-union findings for the hook. Exact false positives were
recorded against current declarations and compiler evidence; not LSP/global
clean. Prior upload findings remain deferred. Private verification artifacts are not
distributed. No browser/build/installed-platform proof is implied;
output-owned errors and final F2c integration remain separate work.

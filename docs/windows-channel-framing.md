# Private app-channel framing

**Implemented:** Node's `AppChannel` receives line-delimited JSON with a maximum
frame size of **1,048,576 UTF-8 bytes**, excluding the terminating LF. This is a
per-frame limit, not a limit on a transport chunk or JavaScript character count.
The outgoing Node frame limit is unchanged.

The receiver counts raw bytes before copying fragments, concatenating a completed
frame, decoding UTF-8 or dispatching JSON. An unfinished frame is subject to the
same limit, including bytes of a multibyte character split across chunks. Exactly
the limit is accepted; one byte more closes the channel. Multiple individually
valid frames can share a larger chunk. Blank lines remain ignored.

An oversized frame is not dispatched. The existing log is:

```text
the app's channel sent a frame that is too long; closing it
```

Existing close semantics apply: the stream is destroyed, close listeners run once,
pending requests reject with `The Gentle Dot app closed its channel.`, and pending
approvals resolve false. No new frame schema or method restrictions are introduced.

## Evidence boundary

`packages/daemon/test/app-channel.test.ts` exercises complete and fragmented ASCII
and UTF-8 overflow, decoder-held partial characters, the exact byte boundary,
split multibyte input, multiple messages, request/approval responses and close
through the public `AppChannel` interface. Rejection checks include unchanged
handler-owned state and counters, no outgoing response, and the exact log/error.

**Verified:** The whole file passed on Windows (16 tests, Vitest 5.0.3), using an
explicitly allowlisted environment and the existing verified private-storage
helper, without compiling or substituting native checks. Earlier runs failed
because that source-mode helper was missing; their receipts were retained.
TypeScript build checking passed in an isolated scratch mirror with unchanged
strictness. A scratch differential against `65bac` matched stdout, stderr and exit
code for valid Unicode inputs across eight IPC methods.

These in-memory checks are not installed Windows pipe, Rust, Go, native approval,
packaged application or cross-platform execution proof. Those require separate
integration/build evidence. Run the whole test file; do not suppress its existing
daemon integration assertions when the native private-storage helper is unavailable.

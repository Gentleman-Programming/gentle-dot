#pragma once
#include "windows-app-channel.h"
#include <cstddef>
#include <cstdint>

namespace gentle_dot::app_channel {
// Native-only opaque heap owner. All calls (including release) must be serialized
// on one host-loop thread; no callbacks, worker, N-API environment or CRT alias.
// A later adapter must adopt/create before ANY spawn, refuse failed startup, drive
// poll on its existing loop, and stop then await closed before resolving close.
struct Stream;
constexpr size_t kStreamReadBytes = 64 * 1024;
constexpr size_t kStreamQueueBytes = 2 * 1024 * 1024;
constexpr size_t kStreamQueueItems = 64;
enum class StreamPhase { open, stopping, closed, retained_failure };
enum class WriteAdmission { accepted, backpressure, stopped, invalid, allocation_failed };
enum class StopMode { drain_writes, abort };
struct StreamStatus {
  StreamPhase phase;
  DWORD error;                 // first native error; no handle or rendered secrets
  bool eof;
  bool pending_io;
  size_t readable_bytes;
  size_t queued_bytes;         // includes whole partially-written head allocation
  size_t queued_items;
  uint64_t accepted_write;
  uint64_t completed_write;   // highest fully delivered ordered ticket, not peer ACK
};
// Consumes adoption.owner only after successful validation and heap allocation.
// Null returns ERROR_INVALID_DATA/ERROR_NOT_ENOUGH_MEMORY via error and leaves
// adoption untouched. Non-null may report initialization failure: stop/poll/release
// it too, and refuse startup whenever error is nonzero. Adoption must be the
// successful exclusive fd3 transaction, not a handle. Every other function except
// release requires a non-null live Stream from this call.
Stream* CreateStream(Adoption& adoption, DWORD& error) noexcept;
// Copy all-or-nothing. Non-accepted calls retain no bytes and issue no ticket.
// Zero size is invalid. Max single write is kStreamQueueBytes. Retry backpressure
// only after queued capacity drops. Accepted writes remain ordered across partial
// completions; completion state, rather than callbacks, settles adapter promises.
// Tickets above completed_write must be rejected on abort/error/terminal EOF;
// successful native close alone does not mean all accepted writes were delivered.
WriteAdmission QueueStreamWrite(Stream*, const void*, size_t, uint64_t& ticket) noexcept;
// Each poll performs at most one completion/issue per direction, never waits.
// Reading pauses while a completed chunk is buffered (bounded read backpressure).
void PollStream(Stream*) noexcept;
size_t TakeStreamRead(Stream*, void* destination, size_t capacity) noexcept;
StreamStatus InspectStream(const Stream*) noexcept;
// Rejects further writes immediately. Drain writes preserves queued order, then
// cancels the outstanding read; abort cancels both and discards undelivered bytes
// only AFTER definitive completion. Drain may be escalated to abort, never reversed.
void StopStream(Stream*, StopMode) noexcept;
// No deadline is a reclamation guarantee. Adapter timeout may reject and continue
// polling, or release: release requests abort and quarantines any uncertain state
// until process exit without retry, wait, thread join, forced exit or callbacks.
// closed means pending I/O is drained AND event/Owner closes succeeded. A prior
// error remains observable even when resources subsequently close successfully.
// No operation is legal after release. Never report retained_failure as success.
void ReleaseStream(Stream*) noexcept;
}  // namespace gentle_dot::app_channel

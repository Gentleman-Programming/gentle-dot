#include "windows-app-channel-stream.h"
#include <atomic>
#include <cstring>
#include <new>
#include <utility>

namespace gentle_dot::app_channel {
namespace {
struct Operation {
  OVERLAPPED overlapped{};
  HANDLE event = nullptr;
  bool pending = false;
  bool cancel_requested = false;
  bool close_failed = false;
};
struct Write {
  Write* next = nullptr;
  BYTE* bytes = nullptr;
  size_t size = 0;
  size_t offset = 0;
  uint64_t ticket = 0;
  ~Write() { delete[] bytes; }
};
}
struct Stream {
  explicit Stream(Owner&& value) noexcept : owner(std::move(value)) {}
  Owner owner;
  Operation read, write;
  BYTE bytes[kStreamReadBytes];
  size_t read_size = 0, read_offset = 0;
  Write* head = nullptr;
  Write* tail = nullptr;
  size_t queued_bytes = 0, queued_items = 0;
  uint64_t accepted = 0, completed = 0;
  StreamPhase phase = StreamPhase::open;
  DWORD error = ERROR_SUCCESS;
  bool eof = false, abort = false;
  Stream* next = nullptr;
};
namespace {
// Foundation adoption has already pinned the addon before moving its owner here.
// Every quarantined record keeps buffers, OVERLAPPEDs, events and Owner together.
std::atomic<Stream*> retained{nullptr};
static_assert(std::atomic<Stream*>::is_always_lock_free);
void Retain(Stream* s) noexcept {
  Stream* head = retained.load(std::memory_order_relaxed);
  do { s->next = head; } while (!retained.compare_exchange_weak(
      head, s, std::memory_order_release, std::memory_order_relaxed));
}
void Fail(Stream& s, DWORD error) noexcept {
  if (!s.error) s.error = error ? error : ERROR_GEN_FAILURE;
  s.phase = StreamPhase::stopping;
  s.abort = true;
}
bool InitEvent(Stream& s, Operation& op) noexcept {
  SECURITY_ATTRIBUTES attributes{sizeof(attributes), nullptr, FALSE};
  op.event = CreateEventW(&attributes, TRUE, FALSE, nullptr);
  if (!op.event) { Fail(s, GetLastError()); return false; }
  DWORD flags = 0;
  if (!GetHandleInformation(op.event, &flags)) {
    Fail(s, GetLastError()); return false;
  }
  if (flags & HANDLE_FLAG_INHERIT) {
    Fail(s, ERROR_INVALID_DATA); return false;
  }
  return true;
}
bool Prepare(Stream& s, Operation& op) noexcept {
  if (!ResetEvent(op.event)) { Fail(s, GetLastError()); return false; }
  op.overlapped = {};
  // Low-bit tagging suppresses IOCP packets. This backend owns completion through
  // GetOverlappedResult only; there is no completion callback left to drain.
  op.overlapped.hEvent = reinterpret_cast<HANDLE>(
      reinterpret_cast<ULONG_PTR>(op.event) | ULONG_PTR{1});
  op.cancel_requested = false;
  return true;
}
void Cancel(Stream& s, Operation& op) noexcept {
  if (!op.pending || op.cancel_requested) return;
  op.cancel_requested = true;
  if (!CancelIoEx(s.owner.borrowed_handle(), &op.overlapped)) {
    DWORD error = GetLastError();
    if (error != ERROR_NOT_FOUND) Fail(s, error);
  }
  // Neither success nor ERROR_NOT_FOUND retires the operation.
}
bool Complete(Stream& s, Operation& op, DWORD& count, DWORD& error) noexcept {
  if (!op.pending || !HasOverlappedIoCompleted(&op.overlapped)) return false;
  if (GetOverlappedResult(s.owner.borrowed_handle(), &op.overlapped, &count, FALSE)) {
    error = ERROR_SUCCESS;
  } else {
    error = GetLastError();
    if (error == ERROR_IO_INCOMPLETE || error == ERROR_INVALID_HANDLE ||
        error == ERROR_INVALID_PARAMETER) {
      // A failed query is not definitive completion evidence. Keep exact state.
      if (error != ERROR_IO_INCOMPLETE) Fail(s, error);
      return false;
    }
  }
  op.pending = false;
  return true;
}
void ReadResult(Stream& s, DWORD count, DWORD error) noexcept {
  if (error == ERROR_OPERATION_ABORTED && s.phase != StreamPhase::open) return;
  if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED ||
      (!error && !count)) {
    s.eof = true;
    s.phase = StreamPhase::stopping;
    s.abort = true;
    return;
  }
  if (error) { Fail(s, error); return; }
  if (count > kStreamReadBytes) { Fail(s, ERROR_INVALID_DATA); return; }
  if (s.phase == StreamPhase::open) { s.read_size = count; s.read_offset = 0; }
}
void Pop(Stream& s) noexcept {
  Write* item = s.head;
  s.head = item->next;
  if (!s.head) s.tail = nullptr;
  s.queued_bytes -= item->size;
  --s.queued_items;
  delete item;
}
void WriteResult(Stream& s, DWORD count, DWORD error) noexcept {
  if (error == ERROR_OPERATION_ABORTED && s.abort) return;
  if (error) { Fail(s, error); return; }
  Write& item = *s.head;
  if (!count || count > item.size - item.offset) { Fail(s, ERROR_WRITE_FAULT); return; }
  item.offset += count;
  if (item.offset == item.size) { s.completed = item.ticket; Pop(s); }
}
bool CloseEvent(Stream& s, Operation& op) noexcept {
  if (op.close_failed) return false;
  if (!op.event) return true;
  if (!CloseHandle(op.event)) {
    op.close_failed = true;
    if (!s.error) s.error = GetLastError();
    return false;  // never retry an uncertain handle value
  }
  op.event = nullptr;
  return true;
}
void Finish(Stream& s) noexcept {
  if (s.read.pending || s.write.pending) return;
  if (!s.abort && s.head) return;
  while (s.head) Pop(s);
  s.read_size = s.read_offset = 0;
  // Attempt all independent closes, but never claim success on any failed close.
  bool read_closed = CloseEvent(s, s.read);
  bool write_closed = CloseEvent(s, s.write);
  bool owner_closed = s.owner.close();
  if (!owner_closed && !s.error) s.owner.close_failure(s.error);
  s.phase = read_closed && write_closed && owner_closed
      ? StreamPhase::closed : StreamPhase::retained_failure;
}
}
Stream* CreateStream(Adoption& adoption, DWORD& error) noexcept {
  error = ERROR_SUCCESS;
  if (adoption.startup_must_refuse() || !adoption.original_removed ||
      adoption.owner.borrowed_handle() == INVALID_HANDLE_VALUE) {
    error = ERROR_INVALID_DATA; return nullptr;
  }
  auto* s = new (std::nothrow) Stream(std::move(adoption.owner));
  if (!s) { error = ERROR_NOT_ENOUGH_MEMORY; return nullptr; }
  if (!InitEvent(*s, s->read) || !InitEvent(*s, s->write)) {
    error = s->error;
    Finish(*s);
  }
  return s;
}
WriteAdmission QueueStreamWrite(Stream* s, const void* bytes, size_t size,
                               uint64_t& ticket) noexcept {
  ticket = 0;
  if (s->phase != StreamPhase::open) return WriteAdmission::stopped;
  if (!bytes || !size || size > kStreamQueueBytes || s->accepted == UINT64_MAX)
    return WriteAdmission::invalid;
  if (s->queued_items == kStreamQueueItems || size > kStreamQueueBytes - s->queued_bytes)
    return WriteAdmission::backpressure;
  auto* item = new (std::nothrow) Write;
  if (!item) return WriteAdmission::allocation_failed;
  item->bytes = new (std::nothrow) BYTE[size];
  if (!item->bytes) { delete item; return WriteAdmission::allocation_failed; }
  std::memcpy(item->bytes, bytes, size);
  item->size = size;
  ticket = item->ticket = ++s->accepted;
  if (s->tail) s->tail->next = item; else s->head = item;
  s->tail = item;
  s->queued_bytes += size;
  ++s->queued_items;
  return WriteAdmission::accepted;
}
void PollStream(Stream* s) noexcept {
  if (s->phase == StreamPhase::closed || s->phase == StreamPhase::retained_failure) return;
  DWORD count = 0, error = 0;
  if (Complete(*s, s->read, count, error)) ReadResult(*s, count, error);
  if (Complete(*s, s->write, count, error)) WriteResult(*s, count, error);
  if (s->phase == StreamPhase::stopping) {
    Cancel(*s, s->read);
    if (s->abort) Cancel(*s, s->write);
    Finish(*s);
    if (s->phase != StreamPhase::stopping) return;
  }
  if (s->phase == StreamPhase::open && !s->read.pending && !s->read_size &&
      Prepare(*s, s->read)) {
    BOOL success = ReadFile(s->owner.borrowed_handle(), s->bytes,
                           static_cast<DWORD>(kStreamReadBytes), nullptr, &s->read.overlapped);
    DWORD result = success ? ERROR_SUCCESS : GetLastError();
    if (success || result == ERROR_IO_PENDING) s->read.pending = true;
    else ReadResult(*s, 0, result);
  }
  if (!s->abort && s->head && !s->write.pending && Prepare(*s, s->write)) {
    Write& item = *s->head;
    BOOL success = WriteFile(s->owner.borrowed_handle(), item.bytes + item.offset,
                            static_cast<DWORD>(item.size - item.offset), nullptr,
                            &s->write.overlapped);
    DWORD result = success ? ERROR_SUCCESS : GetLastError();
    if (success || result == ERROR_IO_PENDING) s->write.pending = true;
    else WriteResult(*s, 0, result);
  }
  // Synchronous success still goes through completion retrieval on the next poll.
  // No buffer or OVERLAPPED is recycled merely because initiation returned true.
}
size_t TakeStreamRead(Stream* s, void* destination, size_t capacity) noexcept {
  if (s->phase != StreamPhase::open || !destination || !capacity) return 0;
  size_t available = s->read_size - s->read_offset;
  size_t count = capacity < available ? capacity : available;
  std::memcpy(destination, s->bytes + s->read_offset, count);
  s->read_offset += count;
  if (s->read_offset == s->read_size) s->read_offset = s->read_size = 0;
  return count;
}
StreamStatus InspectStream(const Stream* s) noexcept {
  return {s->phase, s->error, s->eof, s->read.pending || s->write.pending,
          s->read_size - s->read_offset, s->queued_bytes, s->queued_items,
          s->accepted, s->completed};
}
void StopStream(Stream* s, StopMode mode) noexcept {
  if (s->phase == StreamPhase::closed || s->phase == StreamPhase::retained_failure) return;
  s->phase = StreamPhase::stopping;
  if (mode == StopMode::abort) s->abort = true;
  Cancel(*s, s->read);
  if (s->abort) Cancel(*s, s->write);
}
void ReleaseStream(Stream* s) noexcept {
  if (!s) return;
  StopStream(s, StopMode::abort);
  PollStream(s);
  if (s->phase == StreamPhase::closed) delete s;
  else Retain(s);  // no destructor may violate Owner's fully-drained precondition
}
}  // namespace gentle_dot::app_channel

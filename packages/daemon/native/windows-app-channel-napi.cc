#include "windows-app-channel-napi.h"
#include "windows-app-channel-stream.h"
#include <atomic>
#include <cmath>
#include <new>

namespace gentle_dot::app_channel {
namespace {
// JS contract (N-API 8): adoptAppChannelFd3(true) -> opaque owner. The literal
// true asserts the FOUNDATION startup reservation contract, not a security test:
// caller MUST reject process.channel/connected IPC, reserve fd3 exclusively and
// call before ANY spawn. NODE_CHANNEL_FD absence is NOT proof; bootstrap may have
// deleted it. The foundation additionally rejects visible environmental collision.
// Any thrown adoption/construction error binds startup refusal; never retry or
// start the daemon. This atomic is shared by all environments in this loaded DLL,
// including Workers; there is no per-env reset, even on failure.
// owner.poll()/status() -> snapshot; poll never waits and advances bounded I/O.
// owner.read(maxBytes) -> JS-owned Buffer (possibly empty), 1..65536 safe integer.
// owner.write(Buffer) -> { admission, ticket: bigint }; entire Buffer, 1..2MiB.
// admission: accepted/backpressure/stopped/invalid/allocation_failed; ticket is 0n
// unless accepted. No ticket input/coercion or floating point ticket conversion.
// owner.stop("drain"|"abort") -> snapshot; abort cannot be reversed.
// owner.release() -> PRE-release snapshot, then permanently invalidates owner.
// Release is disposal, NOT a drain promise: only a pre-release closed snapshot
// with error=0 AND completedWrite=acceptedWrite certifies delivery/drain. Other
// snapshots must be treated as failed/uncertain shutdown, never success. Caller
// must observe terminal status before normal disposal; release during pending I/O
// is an emergency abandon into backend quarantine. Release may discard reads.
// JS next unit must drive polling/backpressure, settle tickets <= completedWrite,
// reject remaining tickets on error/EOF/abort, and own its close promise/deadline.
// No fd/HANDLE, callbacks, timers, worker threads, or ownership aliases escape.
std::atomic<bool> adoption_attempted{false};
constexpr napi_type_tag kOwnerTag{0x904c361fb2e04b57ULL, 0xbad848cc66b02d92ULL};
struct Binding {
  Stream* stream = nullptr;
  unsigned participants = 1;  // wrap finalizer; cleanup hook adds one
};
void Dispose(Binding* b) noexcept {
  Stream* s = b->stream;
  b->stream = nullptr;  // exactly-once, including explicit release and teardown
  ReleaseStream(s);
}
void Drop(Binding* b) noexcept { if (--b->participants == 0) delete b; }
void Finalize(napi_env, void* data, void*) {
  auto* b = static_cast<Binding*>(data);
  Dispose(b);
  Drop(b);
}
void Cleanup(void* data) {
  auto* b = static_cast<Binding*>(data);
  Dispose(b);
  Drop(b);
}
// Hook and wrap each own one participant. GC deliberately leaves the tiny hook
// tombstone until env cleanup: no hook removal/JS access in finalizers, no ordering
// assumption, and no freed pointer in an extracted function's callback data. All
// backend calls for an owner occur on its environment's serialized loop thread.
bool Check(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, "ERR_APP_CHANNEL_NAPI", "App channel Node-API operation failed");
  return false;
}
napi_value Invalid(napi_env env, const char* message) {
  napi_throw_type_error(env, "ERR_APP_CHANNEL_OWNER", message);
  return nullptr;
}
Binding* Receiver(napi_env env, napi_callback_info info, size_t& argc, napi_value* argv) {
  napi_value self;
  void* data = nullptr;
  if (!Check(env, napi_get_cb_info(env, info, &argc, argv, &self, &data))) return nullptr;
  bool tagged = false;
  void* raw = nullptr;
  if (napi_check_object_type_tag(env, self, &kOwnerTag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, self, &raw) != napi_ok || !raw || raw != data) {
    Invalid(env, "Invalid or cross-owner app channel receiver"); return nullptr;
  }
  auto* b = static_cast<Binding*>(raw);
  if (!b->stream) { Invalid(env, "App channel owner has been released"); return nullptr; }
  return b;
}
const char* Phase(StreamPhase p) {
  switch (p) {
    case StreamPhase::open: return "open";
    case StreamPhase::stopping: return "stopping";
    case StreamPhase::closed: return "closed";
    case StreamPhase::retained_failure: return "retained_failure";
  }
  return "retained_failure";
}
bool Property(napi_env e, napi_value o, const char* key, napi_value v) {
  return Check(e, napi_set_named_property(e, o, key, v));
}
bool Number(napi_env e, napi_value o, const char* key, double n) {
  napi_value v;
  return Check(e, napi_create_double(e, n, &v)) && Property(e, o, key, v);
}
bool Big(napi_env e, napi_value o, const char* key, uint64_t n) {
  napi_value v;
  return Check(e, napi_create_bigint_uint64(e, n, &v)) && Property(e, o, key, v);
}
bool Text(napi_env e, napi_value o, const char* key, const char* text) {
  napi_value v;
  return Check(e, napi_create_string_utf8(e, text, NAPI_AUTO_LENGTH, &v)) && Property(e, o, key, v);
}
bool Bool(napi_env e, napi_value o, const char* key, bool value) {
  napi_value v;
  return Check(e, napi_get_boolean(e, value, &v)) && Property(e, o, key, v);
}
napi_value Snapshot(napi_env e, Stream* s) {
  const auto v = InspectStream(s);
  napi_value o;
  if (!Check(e, napi_create_object(e, &o)) ||
      !Text(e, o, "phase", Phase(v.phase)) || !Number(e, o, "error", v.error) ||
      !Bool(e, o, "eof", v.eof) || !Bool(e, o, "pendingIo", v.pending_io) ||
      // Bounded by 64 KiB, 2 MiB and 64 items: exact as doubles.
      !Number(e, o, "readableBytes", static_cast<double>(v.readable_bytes)) ||
      !Number(e, o, "queuedBytes", static_cast<double>(v.queued_bytes)) ||
      !Number(e, o, "queuedItems", static_cast<double>(v.queued_items)) ||
      !Big(e, o, "acceptedWrite", v.accepted_write) || !Big(e, o, "completedWrite", v.completed_write)) return nullptr;
  return o;
}
napi_value Status(napi_env e, napi_callback_info i) {
  size_t n = 0; auto* b = Receiver(e, i, n, nullptr);
  return b ? Snapshot(e, b->stream) : nullptr;
}
napi_value Poll(napi_env e, napi_callback_info i) {
  size_t n = 0; auto* b = Receiver(e, i, n, nullptr);
  if (!b) return nullptr;
  PollStream(b->stream);
  return Snapshot(e, b->stream);
}
napi_value Read(napi_env e, napi_callback_info i) {
  size_t n = 2; napi_value args[2]; auto* b = Receiver(e, i, n, args);
  if (!b) return nullptr;
  double max = 0;
  if (n != 1 || napi_get_value_double(e, args[0], &max) != napi_ok ||
      !std::isfinite(max) || max < 1 || max > kStreamReadBytes || std::floor(max) != max)
    return Invalid(e, "read requires an integer from 1 to 65536");
  const auto status = InspectStream(b->stream);
  size_t available = status.phase == StreamPhase::open ? status.readable_bytes : 0;
  size_t count = static_cast<size_t>(max);
  if (count > available) count = available;
  // Allocate JS-owned storage FIRST. Once this succeeds, TakeStreamRead's bounded
  // memcpy cannot allocate/fail; it copies into that storage before advancing the
  // native read cursor. No external Buffer aliases the backend's OVERLAPPED bytes.
  void* destination = nullptr; napi_value buffer;
  if (!Check(e, napi_create_buffer(e, count, &destination, &buffer))) return nullptr;
  // InspectStream and TakeStreamRead run back to back on the one loop thread with no
  // Poll/Stop/Release call between them, so the phase stays as inspected and
  // readable_bytes cannot shrink: TakeStreamRead copies exactly `count` bytes. Its result is
  // not checked because the cursor has already advanced; there is nothing to undo.
  if (count) TakeStreamRead(b->stream, destination, count);
  return buffer;
}
napi_value Write(napi_env e, napi_callback_info i) {
  size_t n = 2; napi_value args[2]; auto* b = Receiver(e, i, n, args);
  if (!b) return nullptr;
  bool buffer = false; void* bytes = nullptr; size_t size = 0;
  if (n != 1 || napi_is_buffer(e, args[0], &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(e, args[0], &bytes, &size) != napi_ok || !bytes ||
      !size || size > kStreamQueueBytes) return Invalid(e, "write requires a nonempty Buffer of at most 2 MiB");
  // Allocate the return envelope before accepting bytes. A later property/BigInt
  // allocation failure can still follow acceptance: caller MUST fail closed and
  // inspect acceptedWrite/status, not retry blindly and duplicate the write.
  napi_value result;
  if (!Check(e, napi_create_object(e, &result))) return nullptr;
  uint64_t ticket = 0;
  const auto admission = QueueStreamWrite(b->stream, bytes, size, ticket);
  const char* name = "invalid";
  switch (admission) {
    case WriteAdmission::accepted: name = "accepted"; break;
    case WriteAdmission::backpressure: name = "backpressure"; break;
    case WriteAdmission::stopped: name = "stopped"; break;
    case WriteAdmission::invalid: break;
    case WriteAdmission::allocation_failed: name = "allocation_failed"; break;
  }
  if (!Text(e, result, "admission", name) || !Big(e, result, "ticket", ticket)) return nullptr;
  return result;
}
napi_value Stop(napi_env e, napi_callback_info i) {
  size_t n = 2; napi_value args[2]; auto* b = Receiver(e, i, n, args);
  if (!b) return nullptr;
  char mode[6] = {}; size_t length = 0; napi_valuetype type;
  if (n != 1 || napi_typeof(e, args[0], &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(e, args[0], nullptr, 0, &length) != napi_ok || length > 5 ||
      napi_get_value_string_utf8(e, args[0], mode, sizeof(mode), &length) != napi_ok)
    return Invalid(e, "stop requires drain or abort");
  StopMode selected;
  if (length == 5 && mode[0]=='d' && mode[1]=='r' && mode[2]=='a' && mode[3]=='i' && mode[4]=='n') selected = StopMode::drain_writes;
  else if (length == 5 && mode[0]=='a' && mode[1]=='b' && mode[2]=='o' && mode[3]=='r' && mode[4]=='t') selected = StopMode::abort;
  else return Invalid(e, "stop requires drain or abort");
  StopStream(b->stream, selected);
  return Snapshot(e, b->stream);
}
napi_value Release(napi_env e, napi_callback_info i) {
  size_t n = 0; auto* b = Receiver(e, i, n, nullptr);
  if (!b) return nullptr;
  napi_value result = Snapshot(e, b->stream);
  if (!result) return nullptr;  // retain owner if snapshot allocation fails
  Dispose(b);
  return result;
}
napi_value Adopt(napi_env e, napi_callback_info i) {
  size_t n = 2; napi_value args[2]; bool reservation = false;
  if (!Check(e, napi_get_cb_info(e, i, &n, args, nullptr, nullptr))) return nullptr;
  if (n != 1 || napi_get_value_bool(e, args[0], &reservation) != napi_ok || !reservation)
    return Invalid(e, "Exclusive startup fd3 reservation assertion required");
  if (adoption_attempted.exchange(true, std::memory_order_acq_rel)) {
    napi_throw_error(e, "ERR_APP_CHANNEL_ADOPTION", "Process app channel adoption already attempted"); return nullptr;
  }
  auto* b = new (std::nothrow) Binding;
  if (!b) { napi_throw_error(e, "ERR_APP_CHANNEL_ALLOC", "App channel owner allocation failed; refuse startup"); return nullptr; }
  auto adoption = AdoptInheritedFd3(ExclusiveFd3Reservation{});
  DWORD error = ERROR_SUCCESS;
  if (!adoption.startup_must_refuse()) b->stream = CreateStream(adoption, error);
  if (!b->stream || error) {
    Dispose(b); Drop(b);
    // The adoption RAII owner closes or quarantines any untransferred duplicate.
    napi_value failure;
    if (Check(e, napi_create_object(e, &failure)) &&
        Number(e, failure, "failure", static_cast<int>(adoption.failure)) &&
        Number(e, failure, "win32Error", adoption.win32_error) &&
        Number(e, failure, "ntStatus", adoption.nt_status) &&
        Number(e, failure, "uvError", adoption.uv_error) &&
        Number(e, failure, "streamError", error) &&
        Bool(e, failure, "originalRemoved", adoption.original_removed)) {
      napi_value message, exception;
      if (Check(e, napi_create_string_utf8(e, "App channel adoption failed; refuse startup", NAPI_AUTO_LENGTH, &message)) &&
          Check(e, napi_create_error(e, nullptr, message, &exception)) && Property(e, exception, "evidence", failure))
        napi_throw(e, exception);
    }
    return nullptr;
  }
  napi_value owner;
  if (!Check(e, napi_create_object(e, &owner)) ||
      !Check(e, napi_wrap(e, owner, b, Finalize, nullptr, nullptr))) {
    Dispose(b); Drop(b); return nullptr;
  }
  if (!Check(e, napi_add_env_cleanup_hook(e, Cleanup, b))) { Dispose(b); return nullptr; }
  ++b->participants;
  napi_property_descriptor methods[] = {
    {"poll", nullptr, Poll, nullptr, nullptr, nullptr, napi_default, b},
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, b},
    {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_default, b},
    {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, b},
    {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, b},
    {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, b},
  };
  if (!Check(e, napi_type_tag_object(e, owner, &kOwnerTag)) ||
      !Check(e, napi_define_properties(e, owner, sizeof(methods)/sizeof(methods[0]), methods))) {
    Dispose(b); return nullptr;
  }
  return owner;
}
}  // namespace
napi_status RegisterAppChannel(napi_env env, napi_value exports) {
  napi_value adopt;
  napi_status status = napi_create_function(env, "adoptAppChannelFd3", NAPI_AUTO_LENGTH, Adopt, nullptr, &adopt);
  return status == napi_ok ? napi_set_named_property(env, exports, "adoptAppChannelFd3", adopt) : status;
}
}  // namespace gentle_dot::app_channel

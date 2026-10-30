// Production Windows-only stop transport. This is not the privileged fd3 channel:
// a same-user descendant may request shutdown, just as it may send a Unix signal.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <intrin.h>
#include <aclapi.h>
#include <node_api.h>
#include "windows-app-channel-napi.h"
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <new>
#include <array>
#include <memory>
#include <string>
#include <mutex>
#include <vector>
#include <stdexcept>

namespace {
constexpr DWORD kDeadlineMs = 2000;
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
void Require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void Napi(napi_status status) { Require(status == napi_ok, "Node-API operation failed"); }
std::vector<BYTE> UserSid(HANDLE token) {
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  Require(size > 0 && size <= 65536, "Invalid user token size");
  std::vector<BYTE> data(size);
  Require(GetTokenInformation(token, TokenUser, data.data(), size, &size) != FALSE,
          "Cannot inspect user token");
  PSID sid = reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid;
  Require(IsValidSid(sid) != FALSE, "Invalid user SID");
  std::vector<BYTE> copy(GetLengthSid(sid));
  Require(CopySid(static_cast<DWORD>(copy.size()), copy.data(), sid) != FALSE,
          "Cannot copy user SID");
  return copy;
}
std::vector<BYTE> ProcessSid() {
  HANDLE token = nullptr;
  Require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) != FALSE,
          "Cannot open process token");
  Handle owned(token);
  return UserSid(token);
}
void ValidateSecurity(HANDLE file, PSID expected) {
  PSID owner = nullptr;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD result = GetSecurityInfo(file, SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &acl, nullptr, &descriptor);
  Require(result == ERROR_SUCCESS, "Cannot inspect record security");
  struct Free { PSECURITY_DESCRIPTOR p; ~Free() { LocalFree(p); } } free{descriptor};
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  Require(owner && IsValidSid(owner) && EqualSid(owner, expected) && acl &&
          GetSecurityDescriptorControl(descriptor, &control, &revision) &&
          (control & SE_DACL_PROTECTED) && IsValidAcl(acl), "Unsafe record owner or DACL");
  Require(acl->AceCount != 0, "Empty record DACL");
  // Deliberately accept only explicit owner allow ACEs, not a permissive DACL
  // followed by denies. Never repair provenance or permissions in this reader.
  for (DWORD i = 0; i < acl->AceCount; ++i) {
    void* raw = nullptr;
    Require(GetAce(acl, i, &raw) != FALSE, "Cannot inspect record ACE");
    auto* header = static_cast<ACE_HEADER*>(raw);
    Require(header->AceType == ACCESS_ALLOWED_ACE_TYPE &&
            header->AceFlags == 0 && header->AceSize >= sizeof(ACCESS_ALLOWED_ACE),
            "Unsafe record ACE");
    auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
    PSID sid = &ace->SidStart;
    constexpr size_t sidOffset = offsetof(ACCESS_ALLOWED_ACE, SidStart);
    Require(header->AceSize >= sidOffset + 8, "Truncated record SID");
    auto* sidBytes = reinterpret_cast<BYTE*>(sid);
    Require(sidBytes[1] <= SID_MAX_SUB_AUTHORITIES &&
            header->AceSize >= sidOffset + 8 + 4 * sidBytes[1] &&
            IsValidSid(sid) && EqualSid(sid, expected), "Foreign record ACE");
  }
}
uint64_t Decimal(const std::string& text) {
  Require(!text.empty() && text.size() <= 20 && (text.size() == 1 || text[0] != '0'),
          "Invalid record identity");
  uint64_t value = 0;
  for (char c : text) {
    Require(c >= '0' && c <= '9', "Invalid record identity");
    unsigned digit = static_cast<unsigned>(c - '0');
    Require(value <= (UINT64_MAX - digit) / 10, "Record identity overflow");
    value = value * 10 + digit;
  }
  return value;
}
unsigned Hex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  throw std::runtime_error("Invalid record hex");
}
struct Record { std::wstring pipe; std::array<BYTE, 32> capability; };
Record ReadRecord(const std::wstring& path, PSID sid) {
  // OPEN_REPARSE_POINT protects the final component; reject any reparse parent
  // too. The retained file handle (no write/delete sharing) is authoritative.
  Require(path.size() >= 3 && path[1] == L':' && path[2] == L'\\' &&
          ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')),
          "Record path must be an absolute local drive path");
  std::wstring root = path.substr(0, 3);
  Require(GetDriveTypeW(root.c_str()) == DRIVE_FIXED, "Record must be on a local fixed drive");
  std::vector<std::unique_ptr<Handle>> ancestors;
  for (size_t i = 3; i <= path.size(); ++i) {
    if (i != path.size() && path[i] != L'\\') continue;
    std::wstring prefix = path.substr(0, i);
    size_t start = prefix.find_last_of(L'\\') + 1;
    std::wstring component = prefix.substr(start);
    Require(!component.empty() && component != L"." && component != L".." &&
            component.find_first_of(L":/") == std::wstring::npos &&
            component.back() != L'.' && component.back() != L' ', "Unsafe record path");
    auto part = std::make_unique<Handle>(CreateFileW(prefix.c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    FILE_ATTRIBUTE_TAG_INFO tag{};
    Require(part->value != INVALID_HANDLE_VALUE &&
            GetFileInformationByHandleEx(part->value, FileAttributeTagInfo, &tag, sizeof(tag)) &&
            !(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT), "Reparse record path");
    ancestors.push_back(std::move(part));
  }
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  Require(file.value != INVALID_HANDLE_VALUE && GetFileType(file.value) == FILE_TYPE_DISK,
          "Cannot open stop record");
  FILE_ATTRIBUTE_TAG_INFO tag{};
  LARGE_INTEGER length{};
  Require(GetFileInformationByHandleEx(file.value, FileAttributeTagInfo, &tag, sizeof(tag)) &&
          !(tag.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) &&
          GetFileSizeEx(file.value, &length) && length.QuadPart > 0 && length.QuadPart <= 256,
          "Unsafe stop record size or type");
  ValidateSecurity(file.value, sid);
  char bytes[257]{};
  DWORD read = 0;
  Require(ReadFile(file.value, bytes, 257, &read, nullptr) && read == length.QuadPart,
          "Cannot read bounded stop record");
  std::string text(bytes, read);
  std::vector<std::string> lines;
  size_t begin = 0;
  for (size_t i = 0; i < text.size(); ++i) {
    Require(text[i] == '\n' || (text[i] >= 32 && text[i] <= 126), "Non-ASCII stop record");
    if (text[i] == '\n') { lines.push_back(text.substr(begin, i - begin)); begin = i + 1; }
  }
  Require(begin == text.size() && lines.size() == 5 && lines[0] == "gentle-dot-stop-v1",
          "Malformed stop record");
  FILETIME created{}, exited{}, kernel{}, user{};
  Require(GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user) != FALSE,
          "Cannot inspect current process identity");
  uint64_t ticks = (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  Require(Decimal(lines[1]) == GetCurrentProcessId() && Decimal(lines[2]) == ticks,
          "Stop record does not identify this process");
  Require(lines[3].size() == 32 && lines[4].size() == 64, "Malformed stop capability");
  for (char c : lines[3]) Hex(c);
  Record record;
  std::string name = "\\\\.\\pipe\\gentle-dot-stop-" + lines[3];
  record.pipe.assign(name.begin(), name.end());
  for (size_t i = 0; i < 32; ++i)
    record.capability[i] = static_cast<BYTE>((Hex(lines[4][2*i]) << 4) | Hex(lines[4][2*i+1]));
  return record;
}
// Only the native worker uses this heap storage. It is never freed/reused while
// the kernel owns an OVERLAPPED, even after close rejection or env destruction.
struct Operation {
  Handle event{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  OVERLAPPED overlapped{};
  std::array<BYTE, 36> bytes{};
  void Reset() {
    overlapped = {};
    overlapped.hEvent = event.value;
    ResetEvent(event.value);
  }
};
struct State {
  napi_env env;
  napi_threadsafe_function tsfn = nullptr;
  napi_deferred deferred = nullptr;
  napi_ref promise = nullptr;
  Handle pipe, stop, ready;
  std::vector<BYTE> sid;
  std::array<BYTE, 32> capability{};
  std::array<BYTE, 36> pendingFrame{}; // immutable once queued
  std::unique_ptr<Operation> operation;
  std::mutex gate;
  bool participant = false; // gate protects every native TSFN call/release
  bool authenticated = false; // worker only: one stop for this launch
  bool deadlineQueued = false; // worker only
  bool finalized = false; // JS only
  std::shared_ptr<State>* hookOwner = nullptr; // JS only, independently owns hook data
  std::atomic<bool> stopping{false}, teardown{false}, deadlineExpired{false}, nativeComplete{false};
  std::atomic<DWORD> error{ERROR_SUCCESS};
  explicit State(napi_env e) : env(e) {}
  void Fail(DWORD code) {
    DWORD expected = ERROR_SUCCESS;
    error.compare_exchange_strong(expected, code ? code : ERROR_GEN_FAILURE);
  }
  void Stop() { stopping.store(true); SetEvent(stop.value); }
};
using Owner = std::shared_ptr<State>;
void ReleaseParticipant(State& s, napi_threadsafe_function_release_mode mode) {
  std::lock_guard<std::mutex> lock(s.gate);
  if (!s.participant) return;
  s.participant = false;
  napi_release_threadsafe_function(s.tsfn, mode);
}
bool Queue(State& s, void* data) {
  std::lock_guard<std::mutex> lock(s.gate);
  if (!s.participant || s.teardown.load()) return false;
  napi_status status = napi_call_threadsafe_function(s.tsfn, data, napi_tsfn_nonblocking);
  // Node may start aborting before our cleanup hook runs. A closing TSFN must
  // never be used again, including release on the worker's behalf.
  if (status == napi_closing) s.participant = false;
  return status == napi_ok;
}
void Cleanup(void* data) {
  std::unique_ptr<Owner> owner(static_cast<Owner*>(data));
  State& s = **owner;
  s.teardown.store(true);
  s.hookOwner = nullptr;
  s.Stop();
  // Serialize with any worker call, then release its participant on its behalf.
  // The worker owns a separate shared_ptr and cannot subsequently touch Node.
  ReleaseParticipant(s, napi_tsfn_abort);
}
void NotifyDeadline(State& s) {
  s.deadlineExpired.store(true);
  if (!s.deadlineQueued && Queue(s, nullptr)) s.deadlineQueued = true;
}
bool ExpectedDisconnect(DWORD code) {
  return code == ERROR_OPERATION_ABORTED || code == ERROR_BROKEN_PIPE ||
         code == ERROR_MORE_DATA || code == ERROR_PIPE_NOT_CONNECTED;
}
// No blocking GetOverlappedResult and no JS-thread join. Once cancellation is
// requested, completion alone permits storage/handle release. If completion is
// late, report failure and keep the worker + pipe + heap operation alive.
bool Complete(State& s, DWORD timeout, DWORD& transferred) {
  Operation& op = *s.operation;
  HANDLE events[] = {s.stop.value, op.event.value};
  DWORD wait = WaitForMultipleObjects(2, events, FALSE, timeout);
  DWORD waitError = wait == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
  if (wait == WAIT_OBJECT_0 + 1) {
    if (GetOverlappedResult(s.pipe.value, &op.overlapped, &transferred, FALSE)) return true;
    DWORD code = GetLastError();
    if (code != ERROR_IO_INCOMPLETE) {
      if (!ExpectedDisconnect(code)) { s.Fail(code); s.Stop(); }
      return false;
    }
    // Even an unexpectedly signaled event is not proof of completed I/O.
  }
  if (wait == WAIT_FAILED) s.Fail(waitError);
  if (!CancelIoEx(s.pipe.value, &op.overlapped)) {
    DWORD code = GetLastError();
    if (code != ERROR_NOT_FOUND) { s.Fail(code); s.Stop(); NotifyDeadline(s); }
  }
  ULONGLONG started = GetTickCount64();
  bool reported = false;
  for (;;) {
    if (GetOverlappedResult(s.pipe.value, &op.overlapped, &transferred, FALSE)) return false;
    DWORD code = GetLastError();
    if (code != ERROR_IO_INCOMPLETE) {
      if (!ExpectedDisconnect(code)) { s.Fail(code); s.Stop(); }
      return false;
    }
    const ULONGLONG elapsed = GetTickCount64() - started;
    if (!reported && elapsed >= kDeadlineMs) {
      s.Fail(ERROR_TIMEOUT); s.Stop(); NotifyDeadline(s);
      reported = true;
    }
    // Poll only the retained operation's completion, not the already-set stop
    // event. If the kernel never retires the cancelled operation, spinning here
    // would hold the pipe handle and this thread forever, so the loop gives up
    // one deadline after the timeout is reported.
    if (elapsed >= kDeadlineMs * 2) return false;
    DWORD completion = WaitForSingleObject(op.event.value, 50);
    if (completion == WAIT_FAILED) { s.Fail(GetLastError()); Sleep(50); }
    else if (completion == WAIT_OBJECT_0) Sleep(10);
  }
}
bool ClientIsOwner(State& s) {
  if (!ImpersonateNamedPipeClient(s.pipe.value)) return false;
  bool matches = false;
  try {
    HANDLE token = nullptr;
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &token)) {
      Handle owned(token);
      auto sid = UserSid(token);
      matches = EqualSid(sid.data(), s.sid.data()) != FALSE;
    }
  } catch (...) { matches = false; }
  // A failed revert leaves this thread running as the client, and no later step is
  // safe under that token: terminate the process at once (Microsoft's guidance).
  if (!RevertToSelf()) __fastfail(FAST_FAIL_FATAL_APP_EXIT);
  return matches;
}
bool CapabilityMatches(const State& s, const std::array<BYTE, 36>& frame) {
  // Fixed 32-byte prefilter; volatile accumulation prevents an early-out
  // optimization. TS retains its own timingSafeEqual authentication defense.
  volatile unsigned difference = 0;
  for (size_t i = 0; i < s.capability.size(); ++i)
    difference = difference | (frame[i + 4] ^ s.capability[i]);
  return difference == 0;
}
void Settle(State& s) {
  if (!s.deferred || s.teardown.load()) return;
  napi_value value;
  DWORD error = s.error.load();
  if (error == ERROR_SUCCESS) {
    // Only TSFN finalization after native completion can resolve drain.
    if (!s.finalized) return;
    if (napi_get_undefined(s.env, &value) != napi_ok ||
        napi_resolve_deferred(s.env, s.deferred, value) != napi_ok) return;
  } else {
    napi_value message;
    std::string text = "Stop listener cleanup failed (Win32 " + std::to_string(error) + ")";
    if (napi_create_string_utf8(s.env, text.c_str(), text.size(), &message) != napi_ok ||
        napi_create_error(s.env, nullptr, message, &value) != napi_ok ||
        napi_reject_deferred(s.env, s.deferred, value) != napi_ok) return;
  }
  s.deferred = nullptr;
}
void Deliver(napi_env env, napi_value callback, void* context, void* data) {
  auto* s = static_cast<State*>(context);
  if (!env || s->teardown.load()) return;
  if (!data) { Settle(*s); return; } // internal failure notification, not onRequest
  if (!callback || s->stopping.load()) return;
  napi_value buffer, receiver, ignored;
  if (napi_create_buffer_copy(env, s->pendingFrame.size(), s->pendingFrame.data(), nullptr, &buffer) != napi_ok ||
      napi_get_undefined(env, &receiver) != napi_ok) {
    s->Fail(ERROR_NOT_ENOUGH_MEMORY); s->Stop(); return;
  }
  napi_status status = napi_call_function(env, receiver, callback, 1, &buffer, &ignored);
  if (status != napi_ok) { s->Fail(ERROR_GEN_FAILURE); s->Stop(); }
  if (status == napi_pending_exception) {
    napi_value exception;
    if (napi_get_and_clear_last_exception(env, &exception) == napi_ok)
      napi_fatal_exception(env, exception);
  }
}
DWORD WINAPI Listen(void* data) {
  std::unique_ptr<Owner> owner(static_cast<Owner*>(data));
  State& s = **owner; // independent native ownership through completion
  Operation& op = *s.operation;
  bool first = true;
  while (!s.stopping.load()) {
    op.Reset();
    BOOL connected = ConnectNamedPipe(s.pipe.value, &op.overlapped);
    DWORD code = connected ? ERROR_SUCCESS : GetLastError();
    DWORD transferred = 0;
    bool accepted = connected || code == ERROR_PIPE_CONNECTED;
    if (!accepted && code != ERROR_IO_PENDING) {
      s.Fail(code); s.Stop(); SetEvent(s.ready.value); break;
    }
    if (first) { SetEvent(s.ready.value); first = false; }
    if (code == ERROR_IO_PENDING) accepted = Complete(s, INFINITE, transferred);
    if (accepted && !s.stopping.load()) {
      op.Reset();
      BOOL done = ReadFile(s.pipe.value, op.bytes.data(), static_cast<DWORD>(op.bytes.size()),
                           &transferred, &op.overlapped);
      code = done ? ERROR_SUCCESS : GetLastError();
      bool valid = done != FALSE;
      if (code == ERROR_IO_PENDING) valid = Complete(s, kDeadlineMs, transferred);
      else if (!valid && !ExpectedDisconnect(code)) { s.Fail(code); s.Stop(); }
      const auto& frame = op.bytes;
      // No short-frame accumulation, and ERROR_MORE_DATA rejects oversize.
      // Wrong capabilities never enter Node's queue. There is at most one
      // authenticated request, plus one internal deadline notification.
      if (!s.authenticated && valid && transferred == frame.size() &&
          frame[0] == 'G' && frame[1] == 'D' && frame[2] == 'S' && frame[3] == '1' &&
          CapabilityMatches(s, frame) && ClientIsOwner(s) && !s.stopping.load()) {
        s.pendingFrame = frame;
        if (Queue(s, s.pendingFrame.data())) s.authenticated = true;
        else { s.Fail(ERROR_GEN_FAILURE); s.Stop(); }
      }
    }
    if (!DisconnectNamedPipe(s.pipe.value)) {
      code = GetLastError();
      if (code != ERROR_PIPE_NOT_CONNECTED) { s.Fail(code); break; }
    }
  }
  s.Stop();
  // Every issued operation has completed before these resources are released.
  s.operation.reset();
  // A failed CloseHandle leaves ownership uncertain; never close the value a second time.
  HANDLE pipe = s.pipe.value;
  s.pipe.value = INVALID_HANDLE_VALUE;
  if (!CloseHandle(pipe)) s.Fail(GetLastError());
  s.nativeComplete.store(true);
  ReleaseParticipant(s, napi_tsfn_release);
  return 0;
}
void FinalizeListener(napi_env env, void* data, void*) {
  std::unique_ptr<Owner> owner(static_cast<Owner*>(data));
  State& s = **owner;
  // Environment destruction may force TSFN finalization independently of its
  // participant count. Disarm the native gate before losing TSFN ownership.
  {
    std::lock_guard<std::mutex> lock(s.gate);
    s.participant = false;
  }
  s.finalized = true;
  if (!s.nativeComplete.load()) { s.teardown.store(true); s.Stop(); }
  // The cleanup hook has independent ownership too: a worker finishing before
  // hook execution cannot leave a dangling hook argument.
  if (env && s.hookOwner &&
      napi_remove_env_cleanup_hook(env, Cleanup, s.hookOwner) == napi_ok) {
    delete s.hookOwner;
    s.hookOwner = nullptr;
  }
  if (!s.teardown.load() && env) Settle(s);
}
napi_value Close(napi_env env, napi_callback_info info) {
  try {
    void* data = nullptr;
    Napi(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &data));
    State& s = **static_cast<Owner*>(data);
    napi_value promise;
    if (s.promise) { Napi(napi_get_reference_value(env, s.promise, &promise)); return promise; }
    napi_deferred deferred;
    Napi(napi_create_promise(env, &deferred, &promise));
    napi_ref reference;
    Napi(napi_create_reference(env, promise, 1, &reference));
    s.promise = reference;
    s.deferred = deferred;
    s.Stop();
    if (s.finalized || s.deadlineExpired.load()) Settle(s);
    return promise;
  } catch (const std::exception& e) { napi_throw_error(env, nullptr, e.what()); return nullptr; }
}
void FinalizeClose(napi_env env, void* data, void*) {
  std::unique_ptr<Owner> owner(static_cast<Owner*>(data));
  State& s = **owner;
  if (!s.teardown.load() && env && s.promise) {
    napi_delete_reference(env, s.promise);
    s.promise = nullptr;
  }
  s.Stop();
}
napi_value Create(napi_env env, napi_callback_info info) {
  Owner state;
  bool nativeStarted = false;
  bool tsfn = false;
  try {
    size_t argc = 2;
    napi_value argv[2];
    Napi(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
    Require(argc == 2, "Expected recordPath and onRequest");
    napi_valuetype type;
    Napi(napi_typeof(env, argv[0], &type)); Require(type == napi_string, "Expected record path string");
    Napi(napi_typeof(env, argv[1], &type)); Require(type == napi_function, "Expected request callback");
    size_t length = 0;
    Napi(napi_get_value_string_utf16(env, argv[0], nullptr, 0, &length));
    Require(length > 0 && length < 32767, "Invalid record path length");
    std::vector<char16_t> path(length + 1);
    Napi(napi_get_value_string_utf16(env, argv[0], path.data(), path.size(), &length));
    for (size_t i = 0; i < length; ++i) Require(path[i] != 0, "NUL in record path");
    state = std::make_shared<State>(env);
    state->sid = ProcessSid();
    Record record = ReadRecord(std::wstring(path.begin(), path.begin() + length), state->sid.data());
    state->capability = record.capability;
    DWORD aclSize = sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) +
                    static_cast<DWORD>(state->sid.size());
    std::vector<BYTE> aclBytes(aclSize);
    PACL acl = reinterpret_cast<PACL>(aclBytes.data());
    SECURITY_DESCRIPTOR descriptor;
    Require(InitializeAcl(acl, aclSize, ACL_REVISION) &&
            AddAccessAllowedAce(acl, ACL_REVISION,
              FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
              state->sid.data()) && InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) &&
            SetSecurityDescriptorOwner(&descriptor, state->sid.data(), FALSE) &&
            SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) &&
            SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED),
            "Cannot create protected owner pipe DACL");
    SECURITY_ATTRIBUTES attributes{sizeof(attributes), &descriptor, FALSE};
    state->pipe.value = CreateNamedPipeW(record.pipe.c_str(),
        PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1, 36, 36, kDeadlineMs, &attributes);
    Require(state->pipe.value != INVALID_HANDLE_VALUE, "Cannot exclusively own stop pipe");
    state->stop.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    state->ready.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    Require(state->stop.value && state->ready.value, "Cannot create listener cancellation events");
    state->operation = std::make_unique<Operation>();
    Require(state->operation->event.value != nullptr, "Cannot create I/O completion event");
    // An outstanding cancellation may outlive its Node environment. Windows
    // cannot promise bounded completion. Pin this addon before starting any
    // native worker: its code/static runtime must remain loaded until process
    // exit, even if Node unloads a Worker environment. This is an explicit,
    // process-lifetime module pin, not an assumed detached-thread lifetime.
    HMODULE module = nullptr;
    Require(GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
              reinterpret_cast<LPCWSTR>(&Listen), &module) != FALSE,
            "Cannot retain native addon code lifetime");
    napi_value resource;
    Napi(napi_create_string_utf8(env, "WindowsStopListener", NAPI_AUTO_LENGTH, &resource));
    std::unique_ptr<Owner> lifetime(new Owner(state));
    Napi(napi_create_threadsafe_function(env, argv[1], nullptr, resource, 2, 1,
        lifetime.get(), FinalizeListener, state.get(), Deliver, &state->tsfn));
    lifetime.release(); tsfn = true; state->participant = true;
    std::unique_ptr<Owner> hookOwner(new Owner(state));
    Napi(napi_add_env_cleanup_hook(env, Cleanup, hookOwner.get()));
    state->hookOwner = hookOwner.release();
    auto* worker = new Owner(state);
    HANDLE thread = CreateThread(nullptr, 0, Listen, worker, 0, nullptr);
    if (!thread) { delete worker; throw std::runtime_error("Cannot start stop listener"); }
    nativeStarted = true;
    // Closing a thread HANDLE does not stop its thread. The worker retains its
    // own State and the module is pinned; no JS/environment join is needed.
    if (!CloseHandle(thread)) state->Fail(GetLastError());
    Require(WaitForSingleObject(state->ready.value, kDeadlineMs) == WAIT_OBJECT_0,
            "Stop listener did not become ready");
    Require(!state->stopping.load(), "Stop listener startup failed");
    napi_value result, capability, close;
    Napi(napi_create_object(env, &result));
    Napi(napi_create_buffer_copy(env, record.capability.size(), record.capability.data(), nullptr, &capability));
    std::unique_ptr<Owner> method(new Owner(state));
    Napi(napi_create_function(env, "close", NAPI_AUTO_LENGTH, Close, method.get(), &close));
    Napi(napi_add_finalizer(env, close, method.get(), FinalizeClose, nullptr, nullptr));
    method.release();
    Napi(napi_set_named_property(env, result, "capability", capability));
    Napi(napi_set_named_property(env, result, "close", close));
    return result;
  } catch (const std::exception& e) {
    if (state) {
      if (state->stop.value && state->stop.value != INVALID_HANDLE_VALUE) state->Stop();
      // On startup failure the worker still owns any issued operation. Keep
      // the cleanup hook until TSFN finalization or environment teardown.
      if (tsfn && !nativeStarted) {
        state->nativeComplete.store(true); // no kernel operation was issued
        ReleaseParticipant(*state, napi_tsfn_abort);
      }
    }
    napi_throw_error(env, nullptr, e.what());
    return nullptr;
  }
}
napi_value Init(napi_env env, napi_value exports) {
  napi_value create;
  if (napi_create_function(env, "createStopListener", NAPI_AUTO_LENGTH, Create, nullptr, &create) != napi_ok ||
      napi_set_named_property(env, exports, "createStopListener", create) != napi_ok) return nullptr;
  if (gentle_dot::app_channel::RegisterAppChannel(env, exports) != napi_ok) return nullptr;
  return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

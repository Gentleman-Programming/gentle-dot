#include "windows-app-channel.h"
#include <winternl.h>
#include <uv.h>
#include <atomic>
#include <new>

namespace gentle_dot::app_channel {
struct OwnerState {
  HANDLE handle = INVALID_HANDLE_VALUE;
  DWORD close_error = ERROR_SUCCESS;
  bool close_failed = false;
  OwnerState* next = nullptr;
};
namespace {
// Failed CloseHandle leaves ownership uncertain. Keep the exact owned duplicate
// and its preallocated record reachable until process exit; never retry it from
// a worker or a static destructor. The borrowed host CRT handle never enters here.
std::atomic<OwnerState*> quarantine{nullptr};
static_assert(std::atomic<OwnerState*>::is_always_lock_free,
              "Quarantine publication must not require allocated lock state");
void Quarantine(OwnerState* state) noexcept {
  OwnerState* head = quarantine.load(std::memory_order_relaxed);
  do {
    state->next = head;
  } while (!quarantine.compare_exchange_weak(head, state,
             std::memory_order_release, std::memory_order_relaxed));
}

// These two information classes/structures are the NT file-query ABI used by
// libuv's Windows pipe adoption. Some Windows SDK winternl.h versions omit the
// named declarations. Use private layouts and explicit class values, never an
// SDK-wide redefinition. IO_STATUS_BLOCK and FILE_INFORMATION_CLASS use SDK types.
struct AccessInformation { ACCESS_MASK flags; };  // FileAccessInformation = 8
struct ModeInformation { ULONG mode; };          // FileModeInformation = 16
constexpr ULONG kSynchronousAlert = 0x10;
constexpr ULONG kSynchronousNonalert = 0x20;
constexpr ACCESS_MASK kReadData = 0x1;
constexpr ACCESS_MASK kWriteData = 0x2;
using QueryFile = NTSTATUS (NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG,
                                    FILE_INFORMATION_CLASS);

// Use only the host Node/libuv CRT wrapper, including its invalid-descriptor
// handling. Never use this addon's CRT _get_osfhandle/_close. In particular the
// host wrapper, not uv_pipe_open or a raw CRT lookup, verifies removal of fd3.
HANDLE HostFd3() noexcept {
  return reinterpret_cast<HANDLE>(uv_get_osfhandle(3));
}
bool Valid(HANDLE handle) noexcept {
  return handle != nullptr && handle != INVALID_HANDLE_VALUE;
}
bool Noninheritable(HANDLE handle) noexcept {
  DWORD flags = 0;
  return GetHandleInformation(handle, &flags) && !(flags & HANDLE_FLAG_INHERIT);
}
}  // namespace

Owner::~Owner() noexcept {
  // Same fully-drained/no-concurrent-use precondition as explicit close(). No
  // allocation, forced exit, or lost ownership on failure during local unwinding.
  if (!close()) {
    Quarantine(state_);
    state_ = nullptr;
  }
}
Owner::Owner(Owner&& other) noexcept : state_(other.state_) {
  other.state_ = nullptr;
}
HANDLE Owner::borrowed_handle() const noexcept {
  return state_ ? state_->handle : INVALID_HANDLE_VALUE;
}
bool Owner::close_failure(DWORD& error) const noexcept {
  const bool failed = state_ && state_->close_failed;
  error = failed ? state_->close_error : ERROR_SUCCESS;
  return failed;
}
bool Owner::close() noexcept {
  if (!state_) return true;
  if (state_->close_failed) return false;  // Never retry an uncertain handle value.
  if (Valid(state_->handle) && !CloseHandle(state_->handle)) {
    state_->close_error = GetLastError();
    state_->close_failed = true;
    return false;  // Keep the state and handle in this owner for caller disposition.
  }
  delete state_;
  state_ = nullptr;
  return true;
}

Adoption AdoptInheritedFd3(ExclusiveFd3Reservation) noexcept {
  Adoption result;
  auto fail = [&](Failure failure, DWORD error = ERROR_SUCCESS) {
    result.failure = failure;
    result.win32_error = error;
  };
  // Detect the standard Node bootstrap IPC collision where visible. Environment
  // absence is not proof of exclusivity: bootstrap can consume/delete this value.
  wchar_t ipc[32] = {};
  SetLastError(ERROR_SUCCESS);
  DWORD length = GetEnvironmentVariableW(L"NODE_CHANNEL_FD", ipc, 32);
  if (length == 0 && GetLastError() != ERROR_ENVVAR_NOT_FOUND &&
      GetLastError() != ERROR_SUCCESS) {
    fail(Failure::environment_query, GetLastError());
    return result;
  }
  if (length != 0) {
    if (length >= 32) {
      fail(Failure::environment_query, ERROR_INVALID_DATA); return result;
    }
    unsigned long long descriptor = 0;
    for (DWORD i = 0; i < length; ++i) {
      if (ipc[i] < L'0' || ipc[i] > L'9' || descriptor > 214748364ULL) {
        fail(Failure::environment_query, ERROR_INVALID_DATA); return result;
      }
      descriptor = descriptor * 10 + (ipc[i] - L'0');
    }
    if (descriptor == 3) {
      fail(Failure::node_ipc_collision); return result;
    }
  }
  HANDLE original = HostFd3();  // borrowed: never pass this to CloseHandle
  if (!Valid(original)) { fail(Failure::missing_fd3); return result; }
  if (GetFileType(original) != FILE_TYPE_PIPE) {
    fail(Failure::not_pipe, GetLastError()); return result;
  }
  DWORD flags = 0, state = 0;
  if (!GetNamedPipeInfo(original, &flags, nullptr, nullptr, nullptr) ||
      !GetNamedPipeHandleStateW(original, &state, nullptr, nullptr, nullptr, nullptr, 0)) {
    fail(Failure::pipe_metadata, GetLastError()); return result;
  }
  if ((flags & (PIPE_SERVER_END | PIPE_TYPE_MESSAGE)) || (state & PIPE_READMODE_MESSAGE)) {
    fail(Failure::not_byte_client); return result;
  }
  ULONG server_pid = 0, client_pid = 0;
  if (!GetNamedPipeServerProcessId(original, &server_pid) ||
      !GetNamedPipeClientProcessId(original, &client_pid)) {
    fail(Failure::connection_identity, GetLastError()); return result;
  }
  if (!server_pid || !client_pid) {
    fail(Failure::connection_identity); return result;
  }
  // Do not require client_pid == Node PID: the parent creates both endpoints.
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  auto query = ntdll ? reinterpret_cast<QueryFile>(
      GetProcAddress(ntdll, "NtQueryInformationFile")) : nullptr;
  if (!query) { fail(Failure::nt_query_unavailable, GetLastError()); return result; }
  // Neither query has an enforced startup deadline. Even the mode query can
  // block on a synchronous handle; exclusive reservation prohibits prior I/O.
  IO_STATUS_BLOCK status = {};
  ModeInformation mode = {};
  result.nt_status = query(original, &status, &mode, sizeof(mode),
                           static_cast<FILE_INFORMATION_CLASS>(16));
  if (result.nt_status != 0 || status.Status != 0 || status.Information != sizeof(mode)) {
    fail(Failure::mode_query); return result;
  }
  if (mode.mode & (kSynchronousAlert | kSynchronousNonalert)) {
    fail(Failure::synchronous_handle); return result;
  }
  status = {};
  AccessInformation access = {};
  result.nt_status = query(original, &status, &access, sizeof(access),
                           static_cast<FILE_INFORMATION_CLASS>(8));
  if (result.nt_status != 0 || status.Status != 0 || status.Information != sizeof(access)) {
    fail(Failure::access_query); return result;
  }
  if ((access.flags & (kReadData | kWriteData)) != (kReadData | kWriteData)) {
    fail(Failure::not_duplex); return result;
  }

  // Reserve the failure-retention record before acquisition or mutation. An
  // allocation failure is an ordinary failed adoption, not noexcept termination.
  result.owner.state_ = new (std::nothrow) OwnerState;
  if (!result.owner.state_) {
    fail(Failure::owner_allocation, ERROR_NOT_ENOUGH_MEMORY); return result;
  }
  // Independently retain this translation unit and its quarantine root before
  // the first handle mutation/acquisition. This irreversible process-lifetime
  // pin remains even if later adoption fails; it never depends on the stop API.
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                         reinterpret_cast<LPCWSTR>(&AdoptInheritedFd3), &module)) {
    fail(Failure::module_pin, GetLastError()); return result;
  }
  // All validation precedes the ownership mutation. No spawn may run on either
  // success or failure until the caller has inspected this transaction result.
  if (!SetHandleInformation(original, HANDLE_FLAG_INHERIT, 0) || !Noninheritable(original)) {
    fail(Failure::original_inheritance, GetLastError()); return result;
  }
  HANDLE duplicate = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(),
                       &duplicate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    fail(Failure::duplication, GetLastError()); return result;
  }
  result.owner.state_->handle = duplicate;  // account for ownership immediately
  if (!Noninheritable(duplicate)) {
    fail(Failure::duplicate_inheritance, GetLastError()); return result;
  }
  uv_fs_t request = {};
  result.uv_error = uv_fs_close(nullptr, &request, 3, nullptr);
  uv_fs_req_cleanup(&request);
  if (result.uv_error != 0) {
    fail(Failure::host_close); return result;
  }
  if (Valid(HostFd3())) {
    fail(Failure::descriptor_still_present); return result;
  }
  result.original_removed = true;
  // The original CRT entry is gone; only the noninheritable RAII duplicate is
  // retained here. Successful adoption still does NOT enable privileged JS IPC.
  return result;
}
}  // namespace gentle_dot::app_channel

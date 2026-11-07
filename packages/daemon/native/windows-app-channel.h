#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

namespace gentle_dot::app_channel {
// Ownership foundation only: no stream, JS acquisition, or export is implemented.
// Before calling, the startup caller must exclusively reserve host CRT fd3:
// no Node IPC/stream adoption, concurrent descriptor operations, outstanding I/O,
// CRT aliases, or other inheritable copies of this privileged endpoint. Neither
// pipe names nor creator PIDs authenticate a signed parent. The inherited
// connection is authority; a parent-created client legitimately has the parent's PID.
// The caller must run this transaction before ANY descendant spawn. A failed
// result binds startup refusal (even if the original descriptor remains open).
// Before ownership mutation, adoption independently pins this addon until process
// exit so quarantined owners/code survive unload attempts. The pin is irreversible,
// including on later adoption failure; no stop-listener construction is required.
struct ExclusiveFd3Reservation {};
struct Adoption;
struct OwnerState;

class Owner final {
 public:
  Owner() noexcept = default;
  ~Owner() noexcept;
  Owner(const Owner&) = delete;
  Owner& operator=(const Owner&) = delete;
  Owner(Owner&& other) noexcept;
  Owner& operator=(Owner&&) = delete;
  // Native-only borrowed access for a later stream unit. Never expose to JS or
  // close this handle elsewhere. Both explicit close AND destruction require all
  // future I/O and completions fully drained, with no concurrent borrowed-handle
  // use. This foundation issues no I/O and implements no drain operation.
  HANDLE borrowed_handle() const noexcept;
  // Failure retains ownership; callers must refuse startup/shutdown completion.
  // Later close calls remain failed without retrying the uncertain handle value.
  // If destruction then fails to close, preallocated state and the uncertain
  // owned handle enter process-lifetime quarantine without allocation or retry.
  // Each such failure retains one state and one handle until process exit.
  bool close() noexcept;
  // True only for a recorded close failure; error is its exact sticky Win32 code.
  // Otherwise sets error to ERROR_SUCCESS. Never closes or queries ambient error.
  bool close_failure(DWORD& error) const noexcept;
 private:
  friend struct Adoption;
  friend Adoption AdoptInheritedFd3(ExclusiveFd3Reservation) noexcept;
  OwnerState* state_ = nullptr;
};

enum class Failure {
  none, node_ipc_collision, environment_query, missing_fd3, not_pipe,
  pipe_metadata, not_byte_client, connection_identity, nt_query_unavailable,
  mode_query, synchronous_handle, access_query, not_duplex,
  owner_allocation, module_pin, original_inheritance, duplication, duplicate_inheritance,
  host_close, descriptor_still_present
};

struct Adoption {
  Owner owner;
  Failure failure = Failure::none;
  // Domain-specific evidence, not a rendered message or raw handle exposure.
  DWORD win32_error = ERROR_SUCCESS;
  LONG nt_status = 0;
  int uv_error = 0;
  // Never retry a close by descriptor number after this call. On close failure
  // fd3's state is uncertain; an unrelated descriptor could subsequently reuse 3.
  bool original_removed = false;
  bool startup_must_refuse() const noexcept { return failure != Failure::none; }
};

Adoption AdoptInheritedFd3(ExclusiveFd3Reservation) noexcept;
}  // namespace gentle_dot::app_channel

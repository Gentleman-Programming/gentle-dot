# Windows computer control: native and presentation source (T2–T4)

**Source implementation only; not Windows-validated or approved for delivery.** T3
now wires Windows helper startup, native prompts, Working readiness, capture-only
preparation and Stop/panic/tray. T4 adds platform-aware UI/binding/MCP/connector copy;
owner Windows compilation and acceptance remain pending. Do not advertise end-to-end Windows control from these
sources. The owner compiles; no isolated environment or new daemon environment is
part of this change.

Scope: Windows computer control, T2–T4, S1–S2. Local task records are not
distributed. S1 remains exactly:
"perfecto, ahora queda implementar el que esto pueda controlar el PC como el quiera, no solo abrir el chrome, sino que pueda hacer click, mover el raton, etc.."
S2 remains: "compilo siempre yo"; "NO QUIERO ENTORNOS AISLADOS";
"el entorno que usa el daemon".

## What exists

`computer::win32::WindowsDesktop` implements the unchanged `Desktop` trait on Windows.
The existing macOS implementation, ANSI key parser, shared policy, MCP transport,
sessions, normal/Yolo mode and core Stop checks are unchanged. The provider itself
neither grants a session nor exposes an input endpoint; T3 supplies application-side
wiring through the existing Helper/Control/server authority. It never executes PowerShell, shell commands,
clipboard mutation, UAC/UIAccess elevation, BlockInput or desktop switching.

Implemented native paths: monitor-under-pointer GDI capture, physical pointer movement,
left/right/single/double click, bounded drag, wheel scrolling, named key combinations,
UTF-16 Unicode text, executable-backed app identities, UIA risk facts, and activation
of verified running apps. Conservative refusals are intentional; they are not claims
that every Windows application can be controlled.

## Public T3 integration surface

All names below are under `computer::win32`; all return errors without provider labels
or raw process paths in diagnostics:

```rust
OwnWindows::new() -> OwnWindows
OwnWindows::register(&self, windows: &[usize]) -> Result<(), String>
OwnWindows::begin_capture(&self) -> Result<CapturePreparation, String>
OwnWindows::begin_capture_with_restore(
    &self, desired: impl Fn(usize) -> Result<bool, String> + 'static
) -> Result<CapturePreparation, String>
CapturePreparation::finish(self) -> Result<(), String>
WindowsDesktop::new(own: OwnWindows) -> WindowsDesktop
pointer_location() -> Result<Point, String>
display_rect_at(at: Point) -> Result<PixelRect, String>
focused_frame() -> Result<PixelRect, String>
```

`PixelRect` has public `x`, `y`, `width`, `height: i32`. `Point` is the existing
`computer::coords::Point`. `OwnWindows` clones share owned integer metadata, **not**
Send/Sync HWNDs or COM objects. Register the complete live Dot/panel/glow top-level
HWND list (1–16 entries) on their owning UI thread. Registration checks own PID,
top-level ownership/thread and capture-affinity set/readback. Re-register recreated
windows. Affinity readback alone is not asserted to prove exclusion on old Windows.

### Capture-only preparation and Working integration

T3 reuses the existing `Working` acknowledgement before every capture/action: show the
visible rings, receive `computer_working_ready` from **glow only**, then hide Dot/panel.
Registration is not readiness, and glow is not hidden for an entire operation.

For **capture only**, the UI thread calls `begin_capture`, retains its !Send guard,
and dispatches `Desktop::capture` on a worker. The guard hides only registered windows
which were visible. Capture refuses visible own top-level windows except the narrowly
validated framework infrastructure below, and requires a DWM composition barrier before reading pixels.
After the worker returns, call `finish` on the UI thread, **before subsequent input**.
The legacy `begin_capture` restores previously visible windows with `SW_SHOWNA`, without
activation, including on error-path Drop. T3 uses `begin_capture_with_restore` instead:
its current-intent callback is installed **before any hide**, so preparation failures
before a guard is returned also consult it. Both finish and Drop read current user
Dot/panel intent and current Control activity; explicitly reopened windows retain that
user intent. Working cleanup separately respects the current operation. Neither path
infers intent from windows deliberately hidden by capture. Missing/failed intent never falls
back to stale showing. A bounded recheck reconciles reentrant intent changes; repeated
instability hides/faults. An incomplete restoration faults the registry. Do not finish/drop the guard while its capture worker is still running.
No mutex is held while waiting for the worker or making native UI calls.

This temporarily hides glow **only while pixels are acquired**. T3 keeps the UI-owned
guard in thread-local storage while the existing MCP worker captures; no guard/COM
interface is sent between threads and the UI thread does not wait for pixel acquisition.
An atomic nonblocking ownership marker excludes input and native prompts throughout
capture and UI restoration. A restoration timeout disables later actions, retaining
the guard for its queued UI cleanup. No continuous-indicator, immediate cleanup while
the UI thread is stalled, atomic GUI-state freeze or actual exclusion proof is claimed.
Own-window races are checked before/after readback and before returning the JPEG;
Windows acceptance must still exercise compositor behavior and rapid window changes.

### Capture-local framework infrastructure (C5/S11–S12)

Pinned source provenance: [tao 0.37.1 `event_loop.rs`](https://docs.rs/crate/tao/0.37.1/source/src/platform_impl/windows/event_loop.rs)
(`create_event_target_window`, `thread_event_target_callback`) and
[tauri-plugin-single-instance 2.5.2 `windows.rs`](https://docs.rs/crate/tauri-plugin-single-instance/2.5.2/source/src/platform_impl/windows.rs)
(`create_event_target_window`, `single_instance_window_proc`), used with tauri-runtime-wry 2.12.1.
Both create zero-size, NULL-parent helper windows and explicitly set `WS_VISIBLE | WS_POPUP`;
they are **not** message-only HWNDs. Creation geometry is not current geometry proof.

Only unregistered `Tao Thread Event Target` and exact `dev.gentleman.gentle-dot-sic`
(identifier plus `-sic`, source-checked against `tauri.conf.json`) can qualify. Every existing
capture verification requires two matching read-only samples: live own PID, registering UI
thread and self root; complete valid bounded UTF-16 class; successful outer **and** client
rectangle queries; an empty client in both dimensions; and the exact stable helper style
profile. Ordinary styles must be `WS_VISIBLE | WS_POPUP` (optionally system-added
`WS_CLIPSIBLINGS`); extended styles must be exactly `WS_EX_NOACTIVATE | WS_EX_LAYERED |
WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT`. Zero/failed style queries cannot match this profile.
The outer rectangle must be non-inverted and either empty in both dimensions or nonempty
in both dimensions. Its frame need not be zero: the owner observed `16x16` outer bounds
with a `0x0` client on both pinned helpers. There is no hardcoded `16x16` allowance.
Unknown classes (even zero-client), registered windows, nonempty clients, unexpected styles,
failed/truncated or changed metadata still refuse. This is a trusted pinned-framework
infrastructure classification, **not** a general Win32 transparency or no-painted-pixels
proof. Failed layered-attribute queries are not used as transparency evidence. Helpers are
never hidden, resized, registered or restored by this exception. Shared input/UIA visibility,
capture affinity, compositor barriers and session/Stop protections are unchanged.
Two samples are not atomic: this relies on the pinned framework helper lifecycle, not a GUI
freeze. Runtime geometry, Windows compilation and actual capture remain owner-only acceptance;
source/model tests are not native proof. Refusal diagnostics retain only HWND/thread/registration.

`focused_frame` and UIA Desktop methods initialize balanced **current-thread MTA COM**.
An incompatible existing STA apartment is refused. T3 should call those on its helper
worker, not move COM interfaces or this function's work into the UI thread. Window
registration/preparation/restoration, conversely, must run on the owning UI thread.

## Coordinate, image and resource contract

Windows uses global **physical pixels** throughout capture geometry, UIA hit tests,
monitor/frame helpers and SendInput. Each operation enters per-monitor-v2 thread DPI
awareness and restores the saved thread context with RAII; no process DPI policy is
changed. Negative monitor origins and the full virtual-desktop origin are retained.
Coordinates are finite, rounded into i32 and checked against actual monitors so gaps
are not silently assigned to another screen.

Capture selects the monitor under the pointer at selection time. A full top-down
32-bit GDI bitmap is limited to 64 MiB and 16384 pixels per side, with checked size
arithmetic. Original selected objects are restored; bitmaps/DCs are released on all
paths. The bitmap is deselected before `GetDIBits`. Undefined X bytes become opaque
before resize, and BGRX is encoded with the existing BGRA-to-JPEG helper/quality.
Output fits existing `MAX_LONG_EDGE`, and `ScreenshotGeometry.scale` is screenshot
pixels per **physical** pixel. No screenshot, label or pixel data is written/logged.

## Target and accessibility refusals

An identity is resolved from a live HWND to its PID, query-limited process handle and
executable path, plus token/session/integrity metadata. Titles do not establish
identity. The ordinary `WinSta0/Default` input and current-thread desktops must match.
Own-process, session-zero/other-session, elevated, UIAccess, higher-integrity and
inaccessible targets are refused. No UAC, secure-desktop or foreground-lock workaround
is attempted. Hosted/cross-process UIA descendants and unsupported/custom control
types are also refused rather than returned as ordinary controllable elements.

The adapter-local exact executable-leaf denylist includes known authorization/system
and password-manager tools and native command shells. It is **not a comprehensive
Windows security denylist**, does not identify every renamed helper, and is not a
replacement for T3's integration/security review of the existing core policy.

A refusal names only an executable already in that fixed list, for example
`protected executable target refused: powershell.exe`; it never adds a full path
or window title. An unsupported executable suffix uses the generic reason
`unsupported executable suffix`, not the arbitrary executable name. These details
do not relax the policy. The foreground check can refuse a screenshot before pixels
are captured, even when the requested later action is only pointer movement.

UIA point/focus/ancestor facts normalize to existing AX role strings. Password and
legacy protected state are checked before names/help; Value/Text patterns are never
read. Legacy pattern absence requires a successful, explicitly Boolean false from
the fixed pattern-availability property with default substitution disabled. Missing,
invalid or failed availability, pattern retrieval and protected-state queries refuse
validation before labels or successful observations. Temporary property variants are
cleared, including unexpected types. Foreground root, focused element ownership and pointer HWND/UIA ownership must
be consistent. An inaccessible or missing UIA result may appear as empty/None at the
legacy trait boundary, but invalidates the request-thread observation. `post` requires
fresh matching successful observations and revalidates native identity/UIA facts;
empty/None is never a native permission shortcut, including in Yolo mode.

Default-button discovery uses a complete window-subtree query for Button/SplitButton
candidates, with an explicit raw-view cache filter and no label/value prefetch. The
64-candidate cap no longer counts unrelated structural layout nodes. Candidate state
is read as metadata; an unrelated disabled non-default button is not an input target.
Before reading a unique default's label, its entire raw ancestry must pass owner,
password/legacy protection, enabled and visibility checks. Unknown legacy support,
query failure, ambiguous defaults, candidate limits and budget exhaustion still
refuse Return and button activation; none is converted to known absence. A successful
empty result is accepted only for complete S_OK enumeration, never an error code.
This default-discovery follow-up currently has source-contract checks and authored
native regressions only; the earlier 25-check Windows proof does not compile or
validate this newer candidate. Actual default-provider behavior remains unproved.
Other keys and text-field spaces can still work. Diagnostics contain fixed failure
categories such as default_unknown_query, default_unknown_candidates,
default_unknown_legacy, default_unknown_ancestry, default_unknown_ambiguous and
default_unknown_budget, never labels or raw identifiers. Chrome is not exempt.

Facts expire after 30 seconds and remain on the request thread; long confirmations
must retry through existing guards. They are revalidated snapshots, **not authority**
tokens. Windows cannot atomically freeze another application's UI/focus across UIA
queries and input insertion; concurrent human/provider changes remain a native
acceptance and independent-security-review concern.

## Input bounds and Stop limitation

At most 256 INPUT records are inserted in one SendInput call; text chunks are at most
128 UTF-16 units. Existing MCP chunks are smaller (20 units). Control characters in
text chunks are rejected; the existing MCP newline path uses Return. Drag has 16
intermediate moves and permits only a same-executable-owner path. No waits/sleeps,
clipboard writes or unlimited input loop are added. Wheel conversion is **nominal**
40 pixels/notch; actual scroll distance depends on Windows/app settings, not an exact
pixel-scroll guarantee.

The unchanged Mac ANSI parser is translated explicitly to Windows typed VK constants.
Mac virtual key numbers are never forwarded. `cmd` means Windows/Super, not an implicit
Ctrl substitution; Fn is unsupported. Named OEM punctuation follows the Windows key
layout; use native Unicode text for exact characters.

Native provider operations use a nonblocking in-flight mutex: concurrent actions are refused,
not queued behind a UI/worker dependency. Initially held human modifiers/buttons and
planned keys cause refusal. Partial insertion computes releases only for downs owned
by the accepted ordered prefix. Errors include exact input/cleanup counts and Win32
codes; UIPI cause is explicitly unknown. Failed cleanup disables further injection
and reports that manual release may be needed. No unconditional 'release all keys'
is sent. Simultaneous new human presses cannot be atomically distinguished from
synthetic state; initial-state refusal/owned cleanup is not a hardware-level guarantee.

`Desktop.post` has **no cancellation token**. Existing helper epoch/Stop checks remain
authoritative before/among calls, but cannot retract a native batch already inserted.
Metadata uses 100 ms UIA connection/transaction timeouts, a 500 ms checked query budget,
a time/storage-bounded raw ancestry walk with cycle detection and 64 matching default-search
button candidates; enumeration is capped at 512 windows. Reaching a traversal resource limit
is not evidence that an application's tree is invalid.
These bounds limit attempts/work, not driver/COM hard-real-time latency. DwmFlush is
one native barrier, not a retry loop. Do not claim instantaneous in-flight Stop.

## App and permission meanings

`list_apps` lists visible, accessible, ordinary-session running apps, deduplicated by
`bundleId = "win32:<lowercase absolute executable path>"`; names are executable stems.
These identifiers are public tool data, not diagnostic logs. `open_app` activates a
listed running app by exact stem or identifier; ambiguous stems require the identifier.
Cold launch/installed-app discovery is unsupported. Activation honors native foreground
restrictions and reports failure; `activate(pid)` cannot report errors through the
unchanged trait and therefore never promises success.

For an explicit `open_app`, a minimized verified target receives one asynchronous
`SW_RESTORE` request (which also requests activation); other targets receive one
`SetForegroundWindow` request. The legacy best-effort dialog-focus restoration does
not restore minimized windows. Activation waits up to 1000 ms, observing at most
every 20 ms, for that same HWND to be foreground and no longer minimized.
A transient NULL foreground is pending, never success. Every probe rechecks the
ordinary desktop and the exact target identity; failed metadata remains refusal.
Windows rejection is not retried or bypassed. After issuing the single native
action, the wait is read-only, so Stop cannot cause a second activation afterward.
Restoration refusal reports `Windows declined window restoration`; lack of completion
reports `application did not restore from minimized state and become foreground`
(or the existing `application did not become foreground` for a normal target).

Windows has no macOS TCC equivalent here. `permissions` only queries ordinary desktop,
UIA/focus, live own-window setup, DWM composition and the cleanup latch. Booleans mean
current native availability, **not a session grant**, an OS permission prompt, or proof
of a future screenshot/input succeeding. No capture or injection is used to probe.
T4 presents these as current prerequisites, not macOS permission requests.

## T3 wiring and T4 handoff

The Windows-only application implementation lives in `computer/windows_app.rs` and
`computer/windows_app/`; macOS-only native bodies and other-platform behavior are
preserved. No diagnostic/debug or MinGit feature is a prerequisite.

| Surface | Windows source contract |
| --- | --- |
| `computer::app::start` | Starts the existing random-token, owner-bound loopback Helper/server. Endpoint presence alone is not availability or a grant. |
| `initialize_windows(&AppHandle)` | Setup/UI thread, after Dot/panel/glow creation: register all three HWNDs and bind Alt+Shift+Escape. Any missing prerequisite leaves authority unavailable. Recreated/extra own windows are not silently accepted. |
| `computer_endpoint` / `computer_status` | Existing response shapes; state stays in Control/Session, not a renderer grant. |
| `computer_permissions` | Existing Boolean shape, queried on a blocking worker/MTA rather than the WebView UI/STA. Means current native prerequisites, never permission or session consent. |
| `computer_request_permission` | Refuses macOS permission requests on Windows with an explicit explanation; there is no TCC prompt to request. |
| `computer_working_ready` | Existing operation id and glow-only acknowledgement. Existing capability/build command definitions need no expansion. |
| `computer_stop`, tray Stop, panic | Same Control authority, plus a Windows prompt-cancellation generation that also changes while the shared session is idle. |
| `computer_set_yolo`, tray Yolo | Explicit native confirmation; existing one-hour limit/defaults. Late Windows confirmation after Stop/panic is turned off without another prompt. |
| `windows_user_visibility` | Internal shell intent updates for ordinary user show/hide requests, distinct from Working/capture's temporary hiding. Not a web command. |

Native Windows prompts use typed `MessageBoxW` with OK/Cancel and Cancel as the explicit
second/default button, not the generic dialog plugin. A current-prompt-thread-only
`WH_MSGFILTER` consumes Return/Escape and marks the result refused even if OK has
focus; hook setup/removal failure, native failure, close and Cancel refuse. There is
no unfiltered fallback. OK activation requires a deliberate action (pointer, or
explicit keyboard selection/Space). Real modal-loop/default/hotkey behavior still
requires owner Windows acceptance; source result/key tests are not that evidence.

The shared idle session intentionally does not advance its epoch on Stop. Windows
therefore stamps each prompt with both the original Control epoch and a separate
cancellation generation. Every Windows Stop/panic invalidates that generation. A
synchronous Control notification fence rejects a stale grant in the dialog-to-grant
commit gap before Helper proceeds. This does not replace the shared session lifetime,
normal/Yolo, blocklist, risk, rate or target checks. Yolo's shared setter is not an
atomic dialog commit; the Windows wrapper corrects a late confirmation to off. A
brief stale state event is possible; this is not an authorization to bypass a grant.

Overlay placement uses native physical monitor rectangles (negative origins retained),
then verifies the requested Tauri physical position/size. CSS mark coordinates alone
are divided by the current WebView scale factor. Best-effort marks never relocate
active Working rings to a different display. No native DPI/compositor proof follows
from the source-level geometry checks.

## T4 presentation: registered, currently ready, and allowed are separate

The existing desktop-local panel guard is unchanged: web/VPS callers do not get
native control. A nonempty endpoint means **helper registration only**. The daemon's
`connected` metadata still has that meaning; it is not a permission/session result.
Disconnecting clears advertised registration and unmounts prerequisite results, but
does not clear a native session or hide its independent Stop banner.

| UI state | Authority |
| --- | --- |
| Helper registered | Nonempty native endpoint; not readiness or consent |
| Current prerequisites met | All three native booleans are strictly true: accessibility, screenRecording, screenshotsSupported |
| Controlling your Windows PC | Native active session event/status only |
| Yolo switch on | Independently confirmed native Yolo event/status only |

Failed/incomplete probes are unavailable, not ready. Check again clears the previous
result; older async responses and results after unmount are ignored. A current ready
probe cannot promise the next screenshot/input will succeed. `screenshotsSupported`
is a capability; requestable permissions remain only `accessibility` and
`screenRecording`.

User-agent detection selects **presentation only**, explicitly Mac, Windows or unknown;
non-Mac does not imply Windows and no user-agent grants native support. macOS keeps
its permission buttons, System Settings behavior, signature/rebuild note and ⌥⇧Esc.
Windows has no fake Grant button or macOS settings instructions. It explains native
prerequisites, Alt+Shift+Escape, verified running-app activation only, no cross-app
drag and the bounded in-flight Stop limitation. Unknown-platform copy stays neutral.
The image-model warning and normal native error path remain in place.

MCP descriptions/errors select Windows wording at compile time, without changing
tool names, schemas, parsing, permission guards, session policy or native authority.
Connector metadata stays platform-neutral; its public list never exposes endpoint
secrets, while private MCP configuration retains the existing bearer transport.

Focused local behavior checks (inert collaborators, no native/renderer proof):

```sh
node --experimental-strip-types --test packages/ui/test/computer-capabilities.node-test.mjs packages/ui/test/computer-binding.node-test.mjs packages/daemon/test/computer-connector.node-test.mjs
```

These checks do not compile Rust/React or establish Windows end-to-end behavior.

## Historical evidence and current proof boundary

Results below describe earlier retained source. They do not validate the current
integration; native builds, independent review and installed acceptance remain pending.

Typed declarations: microsoft/windows-rs pin
`32c3144490c016fe496a0aed769bce60987a2e9d`, `windows = "=0.62.2"`.
Local read-only binding provenance records primary URLs, response IDs and hashes;
local native API evidence indexes used symbols. These verification artifacts are not
distributed. The source-only check also verifies pinned Cargo feature declarations.
Existing voice features/version and Cargo.lock are preserved.

The original foundation's full Rust suite and platform matrix remain unverified.
For the UIA admission redesign, 25 focused Rust checks ran successfully on Windows:
14 keyboard/policy/helper checks, six ancestry checks and five native SAFEARRAY/legacy/
role checks. The previous predicate failed the renamed/moving-field assertion, then
the reviewed candidate passed after restoration. Release compilation and NSIS/MSI
packaging also succeeded. These are pure/synthetic checks, not live UIA/provider,
DPI/focus, compositor, hardware-safety or installed Chrome workflow acceptance.
The Python/source checks and editor diagnostics cannot establish those outcomes.
The independent security review accepted the scoped source conditionally; it is
not native approval or a substitute for owner installation and desktop acceptance.

### Keyboard identity, action risk and presentation

The helper sends text in chunks of20UTF-16 units. Keyboard admission separates
native window/application ownership, validated opaque UIA control identity, and
facts relevant to the current action. A rectangle is presentation, not keyboard
identity; pointer hit testing still requires consistent physical bounds. A renamed
field does not automatically establish a different control either: printable field
text must retain the same valid identity and role without freezing labels unrelated
to that action. Return, activation and non-field actions retain their relevant
risk/default-button checks; an unknown default is never treated as known absence.
Missing or invalid required identities refuse, never fall back to matching geometry.
The same admission decision supplies the fixed refusal category; a property ignored
for that action cannot be reported as its rejection cause.

RuntimeIds are opaque integer sequences, bounded here to64 entries; no component
is interpreted as a process identifier. The returned one-dimensional VT_I4 array
must have four-byte elements, valid nonempty bounded dimensions, checked copying,
and successful native destruction before its identity is admitted. RAII retains
cleanup on errors. IDs are desktop-local and may be reused over time: matching
does not establish permanent identity or eliminate check-to-input races.

Capture targets do not request RuntimeId and retain their spatial snapshot checks.
Initial risk observations still obtain the metadata needed by the existing classifier.
Final keyboard queries can omit unrelated default-button enumeration, but still bind
the control identity, validate its full raw protected ancestry and recheck real keyboard
focus. They do not omit default discovery for an action that depends on it. Pointer
input retains its separate focused-target preflight; keyboard input avoids doing the
same complete ancestry query twice. Password/protected-target refusal, session/Stop,
Working, activation and declared-intent checks remain. Refusals are not retried
automatically; no larger text chunks or injected focus workaround is introduced.

If Terminal is foreground and capture refuses it, use `list_apps` then `open_app`
for an already-running verified Chrome before capture; do not weaken the Terminal
protection. An earlier partial-typing report stopped after the first20-unit chunk. The unrelated-default variation is a source-level reproduction, not proof
that autocomplete caused that specific installed failure. Rust regressions require
a Windows runner; source contracts are not native input or end-to-end acceptance.

### Capture recovery and bounded focus refusal details

On Windows, `list_apps` and `open_app` may precede the first screenshot. Activate
only the requested verified running application by its exact listed executable
identifier; do not substitute Chromium when Chrome was requested. If it cannot be
identified, ask the user. Protected foreground capture remains refused; no input
is sent to the protected application to get past that refusal. This guidance
changes no permission, session, Working, activation or target check.

Focus refusals retain fixed categories without exposing old/new labels, values,
process paths or raw RuntimeIds. They describe the condition that actually denied
this action, not the first difference in an unrelated snapshot. The historical
`focused facts changed after risk assessment (field=frame)` report could mask another
condition and was not proof of a focus switch or an old installed binary.

The raw ancestry walk must reach the exact native window root. All ancestors still
pass ownership/password/legacy/enabled/visibility checks before any labels are read.
Cycle detection and checked storage/time budgets bound work without assuming a
universal16-level UIA tree. Cycles, resource exhaustion, provider failure and failure
to establish the root remain refusals, never permission to inject input. No observer,
logger, filtered-view bypass or focus-stealing workaround is added.

The one authorized diagnostic test compiled under SSH but failed before accessing
Chrome because the input desktop could not be opened (HRESULT0x80070001). Its source
was restored and it was not retried. This supplies no actual Chrome ancestry depth or
cycle/root diagnosis. Actual installed typing/search acceptance remains separate from
source-contract checks, synthetic Rust tests and compilation.

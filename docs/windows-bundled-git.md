# Use system Git on Windows

Gentle Dot uses Git from the application's inherited PATH, as on Linux and macOS.
It no longer bundles MinGit or provides a Git staging command. The owner builds
and validates the installed application; this guide does not authorize a build,
installation, runtime cleanup or environment change.

## Prerequisite

Git must already be available to the environment that launches the application.
The daemon preserves inherited PATH entries and order, then appends only its
runtime `bin` and `node/bin` directories on Windows. An absent or empty PATH uses
those runtime fallbacks; they do not supply Git. Node and the daemon script still
use explicit application paths, including the accepted verbatim-path handling.

A GUI application inherits its launch environment, not terminal aliases,
functions or a PowerShell profile. Existing processes do not automatically
refresh when Windows environment settings change. Terminal Git discovery alone
does not prove that the managed daemon can find Git.

## Existing staged runtimes

Fresh staging does not add Git. Packaging uses the staged runtime as-is, without
an extra MinGit check or a Git-specific filter. For a clean build, use a fresh
staging directory rather than carrying old artifacts into the new checkout.
No automatic cleanup or migration of an existing runtime is performed.

## Preserved environment behavior

Windows `Path`/`PATH` normalization still selects the first lexicographic
case-insensitive key (matching Node), emits one `PATH`, and retains inherited
entries when prepending the engine bin. It does not merge conflicting values or
change POSIX case-sensitive variables. HOME/XDG, credentials, permissions and
profiles are unchanged.

Inert Node checks cover staging plans and manifest admission, not real staging or
console compatibility with the current gentle-pi package. Native PATH tests
remain subject to compilation. Neither source inspection nor Linux-shaped
fixtures establish Windows process spawning, installed Git or RDD health.

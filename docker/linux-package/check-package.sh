#!/usr/bin/env bash
# Runs as root inside a clean distro container (debian:bookworm, ubuntu:24.04, or archlinux):
# installs the package given as $1 with the distro's package manager, then, as a new non-root user,
# smoke-tests the installed app (S29.4). The scripts come from the repository mounted at /src.
#   1. the installed runtime's daemon on a temp HOME with a private Engram; the installed tree is
#      root-owned, so this is the real read-only case;
#   2. the same on a read-only copy (`smoke-runtime.mjs --read-only`);
#   3. the installed binary under Xvfb, until its daemon reports idle on a free port.
set -euo pipefail

package=$1
step() { printf '\n==> %s (%s s)\n' "$1" "$SECONDS"; }

step "Installing $(basename "$package")"
case "$package" in
*.deb)
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq
	apt-get install -y --no-install-recommends "$package"
	installed_files() { dpkg -L gentle-dot; }
	install_tools() { apt-get install -y -qq --no-install-recommends lsof procps xauth xvfb >/dev/null; }
	;;
*.pkg.tar.*)
	# pacman's download sandbox fails under emulation ("error restricting syscalls via seccomp"),
	# as on an Apple Silicon Mac; this throwaway container turns it off.
	sed -i '/^\[options\]/a DisableSandbox' /etc/pacman.conf
	pacman -Sy --noconfirm >/dev/null
	pacman -U --noconfirm "$package"
	installed_files() { pacman -Qlq gentle-dot; }
	install_tools() { pacman -S --noconfirm --needed lsof procps-ng xorg-server-xvfb xorg-xauth >/dev/null; }
	;;
*)
	echo "check-package: unknown package type $package" >&2
	exit 1
	;;
esac

installed_files >/tmp/gentle-dot-files
binary=$(grep -m1 '/bin/gentle-dot$' /tmp/gentle-dot-files)
cli=$(grep -m1 '/runtime/daemon/cli.mjs$' /tmp/gentle-dot-files)
runtime=$(dirname "$(dirname "$cli")")
node="$runtime/node/bin/node"
echo "binary: $binary"
echo "runtime: $runtime ($(du -sh "$runtime" | cut -f1), owner $(stat -c %U "$runtime"))"
# Only the package and its declared dependencies are installed at this point.
if ldd "$binary" | grep 'not found'; then
	echo "check-package: the installed binary has unresolved libraries" >&2
	exit 1
fi
echo "ldd: every library of $binary resolves"
"$node" --version
"$runtime/bin/engram" version
"$runtime/bin/pi" --version

step "Installing the smoke tools (lsof, ps, Xvfb)"
install_tools
useradd --create-home tester
run_as_tester() { runuser -u tester -- env -i PATH=/usr/bin:/bin "$@"; }

step "Daemon smoke on the installed runtime (root-owned, read-only for tester)"
run_as_tester "$node" /src/scripts/package/smoke-runtime.mjs --runtime "$runtime"

step "Daemon smoke on a read-only copy"
run_as_tester "$node" /src/scripts/package/smoke-runtime.mjs --runtime "$runtime" --read-only

step "App launch under Xvfb"
run_as_tester "$node" /src/scripts/package/linux-app-smoke.mjs --binary "$binary" --runtime "$runtime"

step "All checks passed"

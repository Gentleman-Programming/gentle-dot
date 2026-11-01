#!/usr/bin/env bash
# Builds Gentle Dot from this source tree on Fedora and installs a launcher.
# Usage: scripts/linux/setup-fedora.sh [--yes] [--no-launch]
# Safe to run again: steps that are already done are skipped or refreshed.
set -euo pipefail

# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# shellcheck disable=SC1091 # present on every Fedora system
DISTRO_NAME="$(. /etc/os-release && echo "${PRETTY_NAME:-Fedora Linux}")"

# Tauri 2 Linux prerequisites (https://v2.tauri.app/start/prerequisites/), plus git (the
# assistant's engine checks for it) and xz for the Node.js download.
# Note: On Fedora 44+, /usr/bin/wget is provided by wget2-wget (rpm -q wget fails
# because the file is provided by wget2-wget package). We check for the binary
# availability instead of the package name.
SYSTEM_PACKAGES=(
	webkit2gtk4.1-devel
	openssl-devel
	curl
	wget
	file
	libxdo-devel
	libayatana-appindicator-gtk3-devel
	librsvg2-devel
	gcc
	gcc-c++
	git
	xz
)

# GNOME shows tray icons only through the AppIndicator extension. Fedora GNOME
# does not ship it by default; user must install the extension or use a
# StatusNotifierWatcher-compatible tray.
case "${XDG_CURRENT_DESKTOP:-}" in
*GNOME* | *gnome*) SYSTEM_PACKAGES+=(gnome-shell-extension-appindicator) ;;
esac

missing_packages() {
	local package
	for package in "${SYSTEM_PACKAGES[@]}"; do
		# Use rpm -q --whatprovides to check if binary is available (covers wget2-wget, etc.)
		if ! rpm -q --whatprovides "$package" >/dev/null 2>&1; then
			# Also check if the binary itself exists in PATH for common commands
			local binary
			case "$package" in
				wget) binary="wget" ;;
				curl) binary="curl" ;;
				file) binary="file" ;;
				git) binary="git" ;;
				gcc) binary="gcc" ;;
				xz) binary="xz" ;;
			esac
			if [ -n "${binary:-}" ] && command -v "$binary" >/dev/null 2>&1; then
				continue
			fi
			printf '%s ' "$package"
		fi
	done
}

install_packages() {
	sudo dnf install -y "$@"
}

run_setup
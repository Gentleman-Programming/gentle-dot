#!/usr/bin/env bash
# Builds Gentle Dot from this source tree on Debian or Ubuntu and installs a launcher.
# Usage: scripts/linux/setup-debian.sh [--yes] [--no-launch]
# Safe to run again: steps that are already done are skipped or refreshed.
set -euo pipefail

# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# shellcheck disable=SC1091 # present on every Debian and Ubuntu
DISTRO_NAME="$(. /etc/os-release && echo "${PRETTY_NAME:-Debian}")"

# Tauri 2 Linux prerequisites (https://v2.tauri.app/start/prerequisites/), plus git (the
# assistant's engine checks for it) and xz-utils and ca-certificates for the Node.js download.
SYSTEM_PACKAGES=(
	libwebkit2gtk-4.1-dev
	build-essential
	curl
	wget
	file
	libxdo-dev
	libssl-dev
	libayatana-appindicator3-dev
	librsvg2-dev
	git
	xz-utils
	ca-certificates
)
# GNOME shows tray icons only through the AppIndicator extension. Ubuntu ships it; Debian does not.
case "${XDG_CURRENT_DESKTOP:-}" in
*GNOME* | *gnome*) SYSTEM_PACKAGES+=(gnome-shell-extension-appindicator) ;;
esac

missing_packages() {
	local package
	for package in "${SYSTEM_PACKAGES[@]}"; do
		dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed" ||
			printf '%s ' "$package"
	done
}

install_packages() {
	sudo apt-get update
	sudo apt-get install -y "$@"
}

run_setup

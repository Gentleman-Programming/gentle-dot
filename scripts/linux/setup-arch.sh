#!/usr/bin/env bash
# Builds Gentle Dot from this source tree on Omarchy or Arch Linux and installs a launcher.
# Usage: scripts/linux/setup-arch.sh [--yes] [--no-launch]
# Safe to run again: steps that are already done are skipped or refreshed.
set -euo pipefail

# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# shellcheck disable=SC1091 # present on every Arch system
DISTRO_NAME="$(. /etc/os-release && echo "${PRETTY_NAME:-Arch Linux}")"
if [ -d "$HOME/.local/share/omarchy" ] || [ -n "${OMARCHY_PATH:-}" ]; then
	DISTRO_NAME="Omarchy ($DISTRO_NAME)"
fi

# Tauri 2 Linux prerequisites (https://v2.tauri.app/start/prerequisites/), plus git (the
# assistant's engine checks for it) and xz for the Node.js download. The docs list
# libappindicator-gtk3, which Arch no longer ships (checked 2026-10-08); the tray loads
# libayatana-appindicator first anyway.
SYSTEM_PACKAGES=(
	webkit2gtk-4.1
	base-devel
	curl
	wget
	file
	openssl
	appmenu-gtk-module
	libayatana-appindicator
	librsvg
	xdotool
	git
	xz
)

missing_packages() {
	local package
	for package in "${SYSTEM_PACKAGES[@]}"; do
		pacman -Q "$package" >/dev/null 2>&1 || printf '%s ' "$package"
	done
}

install_packages() {
	local flags=(--needed)
	if [ "$ASSUME_YES" = 1 ]; then
		flags+=(--noconfirm)
	fi
	# No -y: Arch does not support partial upgrades. If a package is not found, the package
	# database is out of date: run `sudo pacman -Syu`, then this script again.
	sudo pacman -S "${flags[@]}" "$@"
}

run_setup

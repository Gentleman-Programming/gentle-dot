#!/usr/bin/env bash
# Removes what setup-debian.sh or setup-arch.sh installed for your user: the launcher, the
# menu entry, the "Launch at login" entry, and the private Node.js. It never uses sudo.
# Kept unless you pass --purge: your assistant data in ~/.gentle-dot (sign-ins, chats).
# Never removed: system packages, Rust, and this source tree (the commands are printed).
# Usage: scripts/linux/uninstall.sh [--yes] [--purge]
set -euo pipefail

ASSUME_YES=0
PURGE=0
for arg in "$@"; do
	case "$arg" in
	--yes | -y) ASSUME_YES=1 ;;
	--purge) PURGE=1 ;;
	--help | -h)
		echo "Usage: $0 [--yes] [--purge]"
		exit 0
		;;
	*)
		echo "Unknown option: $arg (see --help)" >&2
		exit 2
		;;
	esac
done

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

confirm() {
	if [ "$ASSUME_YES" = 1 ]; then
		return 0
	fi
	[ -t 0 ] || return 1
	local answer
	read -r -p "    $1 [y/N] " answer
	case "$answer" in
	[yY] | [yY][eE][sS]) return 0 ;;
	*) return 1 ;;
	esac
}

remove() {
	if [ -e "$1" ] || [ -L "$1" ]; then
		rm -rf -- "$1"
		echo "    removed $1"
	else
		echo "    not found: $1"
	fi
}

echo "==> Gentle Dot uninstall"
if pgrep -x gentle-dot >/dev/null 2>&1; then
	echo "    Gentle Dot is running. Choose Quit in its tray menu first, then run this again."
	exit 1
fi

echo "==> Launcher and menu entries"
# Only a link into a source tree: never someone else's gentle-dot command.
if [ -L "$HOME/.local/bin/gentle-dot" ]; then
	remove "$HOME/.local/bin/gentle-dot"
else
	echo "    not found: $HOME/.local/bin/gentle-dot (or not a link; left alone)"
fi
remove "$DATA_HOME/applications/gentle-dot.desktop"
remove "$CONFIG_HOME/autostart/Gentle Dot.desktop"

echo "==> Private Node.js"
remove "$DATA_HOME/gentle-dot"

echo "==> Assistant data"
if [ "$PURGE" = 1 ] && [ -d "$HOME/.gentle-dot" ]; then
	echo "    $HOME/.gentle-dot holds your sign-ins, connectors, and chats."
	if confirm "Delete it for good?"; then
		remove "$HOME/.gentle-dot"
	else
		echo "    kept $HOME/.gentle-dot"
	fi
else
	echo "    kept $HOME/.gentle-dot (pass --purge to delete it)"
fi

echo "==> Left in place"
echo "    Build output: $REPO_ROOT/apps/desktop/src-tauri/target (delete it to free space)"
echo "    Rust:         rustup self uninstall"
echo "    Packages:     remove them with apt or pacman if nothing else uses them"
echo "Done."

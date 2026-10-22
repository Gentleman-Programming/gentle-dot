# shellcheck shell=bash
# Shared steps for setup-debian.sh and setup-arch.sh. Sourced, not run.
# The distro script defines: DISTRO_NAME, SYSTEM_PACKAGES (array), missing_packages(),
# and install_packages(). Everything else here runs as the user, without sudo.

NODE_MAJOR=24
APP_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/gentle-dot"
BIN_DIR="$HOME/.local/bin"
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/gentle-dot.desktop"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_BINARY="$REPO_ROOT/apps/desktop/src-tauri/target/release/gentle-dot"
ASSUME_YES=0
LAUNCH=1
STEP=0

for arg in "$@"; do
	case "$arg" in
	--yes | -y) ASSUME_YES=1 ;;
	--no-launch) LAUNCH=0 ;;
	--help | -h)
		echo "Usage: $0 [--yes] [--no-launch]"
		echo "  --yes        answer yes to every question (sudo may still ask for your password)"
		echo "  --no-launch  do not offer to start Gentle Dot at the end"
		exit 0
		;;
	*)
		echo "Unknown option: $arg (see --help)" >&2
		exit 2
		;;
	esac
done

step() {
	STEP=$((STEP + 1))
	printf '\n\033[1;35m==> %s. %s\033[0m\n' "$STEP" "$*"
}

info() {
	printf '    %s\n' "$*"
}

fail() {
	printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
	exit 1
}

# confirm "Question?" -> 0 for yes. Defaults to yes with --yes, and to no without a terminal.
confirm() {
	if [ "$ASSUME_YES" = 1 ]; then
		return 0
	fi
	if [ ! -t 0 ]; then
		return 1
	fi
	local answer
	read -r -p "    $1 [y/N] " answer
	case "$answer" in
	[yY] | [yY][eE][sS]) return 0 ;;
	*) return 1 ;;
	esac
}

check_user() {
	step "Checking the system"
	if [ "$(id -u)" = 0 ]; then
		fail "run this script as your normal user, not root. It asks for sudo only to install system packages."
	fi
	info "Distribution: $DISTRO_NAME"
	info "Source tree:  $REPO_ROOT"
	info "Session:      ${XDG_SESSION_TYPE:-unknown}, desktop ${XDG_CURRENT_DESKTOP:-unknown}"
}

system_packages() {
	step "System libraries (WebKitGTK, tray, build tools)"
	local missing
	missing="$(missing_packages)"
	if [ -z "$missing" ]; then
		info "All present: ${SYSTEM_PACKAGES[*]}"
		return
	fi
	info "Missing: $missing"
	info "The desktop app is built with Tauri, which needs these system libraries."
	info "Installing them is the only step that uses sudo (your package manager)."
	if ! confirm "Install them now with sudo?"; then
		fail "cannot build without them. Install them yourself and run this script again."
	fi
	# shellcheck disable=SC2086 # one word per package
	install_packages $missing
}

node_major() {
	"$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# Node 24 from nodejs.org, unpacked under ~/.local/share/gentle-dot: no sudo, the same on
# every distro, and it ships corepack, which provides the pnpm version the repo pins.
install_private_node() {
	local arch
	case "$(uname -m)" in
	x86_64) arch=x64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) fail "no Node.js $NODE_MAJOR build for $(uname -m)" ;;
	esac
	local base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
	local tmp
	tmp="$(mktemp -d)"
	curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
	local file
	file="$(grep -m 1 -o "node-v$NODE_MAJOR\.[0-9.]*-linux-$arch\.tar\.xz" "$tmp/SHASUMS256.txt")"
	[ -n "$file" ] || fail "cannot find Node.js $NODE_MAJOR for linux-$arch at $base"
	info "Downloading $file"
	curl -fsSL "$base/$file" -o "$tmp/$file"
	(cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || fail "checksum mismatch for $file"
	mkdir -p "$APP_HOME"
	tar -xJf "$tmp/$file" -C "$APP_HOME"
	ln -sfn "$APP_HOME/${file%.tar.xz}" "$APP_HOME/node"
	rm -rf "$tmp"
}

setup_node() {
	step "Node.js $NODE_MAJOR and pnpm"
	local system_node
	system_node="$(command -v node || true)"
	if [ -n "$system_node" ] && [ "$(node_major "$system_node")" -ge "$NODE_MAJOR" ] &&
		{ command -v pnpm >/dev/null || command -v corepack >/dev/null; }; then
		info "Using $system_node ($(node --version))"
	elif [ -x "$APP_HOME/node/bin/node" ]; then
		export PATH="$APP_HOME/node/bin:$PATH"
		info "Using $APP_HOME/node ($(node --version))"
	else
		info "Installing Node.js $NODE_MAJOR for your user in $APP_HOME (no sudo)."
		install_private_node
		export PATH="$APP_HOME/node/bin:$PATH"
		info "Installed $(node --version)"
	fi
	if ! command -v pnpm >/dev/null; then
		# The repo scripts call `pnpm` by name, so put corepack's shim on PATH, in a folder of
		# ours (no sudo). corepack reads the pnpm version from package.json ("packageManager").
		mkdir -p "$APP_HOME/bin"
		corepack enable --install-directory "$APP_HOME/bin" pnpm
		export PATH="$APP_HOME/bin:$PATH"
	fi
	export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
	(cd "$REPO_ROOT" && info "pnpm $(pnpm --version)")
}

RUST_MIN_MINOR=90 # tauri-plugin-single-instance needs Rust 1.90 (edition 2024)

rust_ok() {
	command -v cargo >/dev/null && command -v rustc >/dev/null &&
		[ "$(rustc --version | sed -E 's/^rustc 1\.([0-9]+).*/\1/')" -ge "$RUST_MIN_MINOR" ] 2>/dev/null
}

setup_rust() {
	step "Rust 1.$RUST_MIN_MINOR or later (rustup, for your user)"
	if [ -f "$HOME/.cargo/env" ]; then
		# shellcheck disable=SC1091 # created by rustup
		. "$HOME/.cargo/env"
	fi
	if ! rust_ok && command -v rustup >/dev/null; then
		info "Updating the stable toolchain with rustup"
		rustup update stable --no-self-update
	fi
	if rust_ok; then
		info "Using $(rustc --version)"
		return
	fi
	info "No Rust 1.$RUST_MIN_MINOR+ found. rustup installs it in ~/.rustup and ~/.cargo, without sudo."
	if ! confirm "Install Rust with rustup now?"; then
		fail "cannot build without Rust. Install it from https://rustup.rs and run this script again."
	fi
	curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
	# shellcheck disable=SC1091 # created by rustup
	. "$HOME/.cargo/env"
	rust_ok || fail "rustup finished but $(command -v rustc) is still older than 1.$RUST_MIN_MINOR"
	info "Installed $(rustc --version)"
}

build_app() {
	cd "$REPO_ROOT"
	step "Installing JavaScript dependencies (pnpm install)"
	pnpm install --frozen-lockfile
	step "Building the UI and the assistant (pnpm build)"
	pnpm build
	step "Building the desktop app (a few minutes the first time)"
	# build.rs records the node path and PATH seen here; the app starts the assistant with them.
	pnpm --filter @gentle-dot/desktop tauri build --no-bundle
	[ -x "$APP_BINARY" ] || fail "the build finished but $APP_BINARY is missing"
	info "Built $APP_BINARY"
}

install_launcher() {
	step "Installing the launcher"
	mkdir -p "$BIN_DIR" "$(dirname "$DESKTOP_FILE")"
	ln -sfn "$APP_BINARY" "$BIN_DIR/gentle-dot"
	info "Command: $BIN_DIR/gentle-dot (add --toggle to show or hide the panel)"
	cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Gentle Dot
Comment=Your always-on assistant
Exec=$BIN_DIR/gentle-dot
Icon=$REPO_ROOT/apps/desktop/src-tauri/icons/128x128.png
Terminal=false
Categories=Utility;
StartupWMClass=gentle-dot
Actions=toggle;

[Desktop Action toggle]
Name=Show or hide the panel
Exec=$BIN_DIR/gentle-dot --toggle
EOF
	info "Menu entry: $DESKTOP_FILE"
	if command -v update-desktop-database >/dev/null; then
		update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true
	fi
}

print_next_steps() {
	step "Next steps"
	info "Testing checklist: $REPO_ROOT/docs/linux-testing.md"
	case "${XDG_CURRENT_DESKTOP:-}" in
	*Hyprland* | *hyprland*)
		info "Hyprland: add the window rules and the SUPER + ALT + D binding from"
		info "  $REPO_ROOT/scripts/linux/hyprland/gentle-dot.lua   (hyprland.lua, Omarchy 4)"
		info "  $REPO_ROOT/scripts/linux/hyprland/gentle-dot.conf  (hyprland.conf)"
		;;
	*GNOME* | *gnome*)
		info "GNOME: add a keyboard shortcut in Settings > Keyboard > Custom Shortcuts"
		info "  command: $BIN_DIR/gentle-dot --toggle"
		info "GNOME tray icon: the AppIndicator extension must be on (Ubuntu has it on already):"
		info "  gnome-extensions enable ubuntu-appindicators@ubuntu.com, then log out and back in"
		;;
	*)
		info "Bind this command to a keyboard shortcut in your desktop settings:"
		info "  $BIN_DIR/gentle-dot --toggle"
		;;
	esac
	case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) info "Note: $BIN_DIR is not on your PATH; use the full path above." ;;
	esac
}

launch_app() {
	[ "$LAUNCH" = 1 ] || return 0
	if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; then
		info "No graphical session here; start Gentle Dot from your desktop's app menu."
		return 0
	fi
	if confirm "Start Gentle Dot now?"; then
		nohup "$BIN_DIR/gentle-dot" >/dev/null 2>&1 &
		info "Started. The rose appears at the right edge of the screen."
	fi
}

run_setup() {
	set -euo pipefail
	check_user
	system_packages
	setup_node
	setup_rust
	build_app
	install_launcher
	print_next_steps
	launch_app
	printf '\n\033[1;32mDone.\033[0m\n'
}

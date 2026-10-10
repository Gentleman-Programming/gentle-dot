#!/usr/bin/env bash
# Runs inside gentle-dot-linux-check (see Dockerfile.check). Copies the working tree mounted at
# /src and checks the desktop crate on Linux (S25.7):
#   1. `cargo test` and `cargo clippy --all-targets -- -D warnings`;
#   2. the Secret Service store against no session bus, a bus with no provider, GNOME Keyring
#      unlocked with a test password (the real put/get/delete contract under a throwaway service),
#      and the same keyring locked (refused, without waiting on a prompt nobody can answer);
#   3. the app channel on Linux: the app's spawn hands fd 3 to a real Node daemon stand-in, whose
#      children never hold it (Rust test), and the daemon's own test of the same (vitest).
set -euo pipefail

step() { printf '\n==> %s (%s s)\n' "$1" "$SECONDS"; }

step "Copying the working tree from /src (tracked and untracked files, minus .gitignore)"
cd /src
git ls-files -z --cached --others --exclude-standard -- . ':!:.codegraph' ':!:.atl' |
	tar --null --files-from=- --ignore-failed-read -cf - 2>/dev/null | tar -xf - -C /work
cd /work
# tauri's generate_context! needs the frontend folder to exist; the tests never load it.
mkdir -p packages/ui/dist/app
[ -e packages/ui/dist/app/index.html ] || printf '<!doctype html>\n' >packages/ui/dist/app/index.html

cd /work/apps/desktop/src-tauri
step "cargo test"
cargo test

step "cargo clippy --all-targets -- -D warnings"
cargo clippy --all-targets -- -D warnings

# Each Secret Service case runs with a throwaway HOME and runtime folder, so no keyring outlives it.
fresh_home() {
	HOME=$(mktemp -d)
	XDG_RUNTIME_DIR=$(mktemp -d)
	chmod 700 "$XDG_RUNTIME_DIR"
	export HOME XDG_RUNTIME_DIR
	unset DISPLAY WAYLAND_DISPLAY
}
ignored() { cargo test --lib -- --ignored --nocapture --exact "$@"; }
UNAVAILABLE=secure_store::linux::tests::without_a_secret_service_the_store_is_unavailable

step "Secret Service: no session bus"
(fresh_home && env -u DBUS_SESSION_BUS_ADDRESS cargo test --lib -- --ignored --nocapture --exact "$UNAVAILABLE")

step "Secret Service: a session bus with no provider (no activatable services)"
bus_config=$(mktemp)
cat >"$bus_config" <<'EOF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF
(fresh_home && dbus-run-session --config-file="$bus_config" -- \
	cargo test --lib -- --ignored --nocapture --exact "$UNAVAILABLE")

step "Secret Service: GNOME Keyring unlocked with a test password, then locked"
(
	fresh_home
	export -f ignored
	dbus-run-session -- bash -euc '
		printf "gentle-dot-test" | gnome-keyring-daemon --unlock --components=secrets >/dev/null
		ignored secure_store::linux::tests::real_secret_service_keeps_the_contract_under_a_throwaway_service
		# Encrypted at rest: a stored value never appears in the keyring files.
		printf "at-rest-marker-7f3a" | secret-tool store --label=at-rest app gentle-dot-test
		sleep 1
		if grep -rq "at-rest-marker-7f3a" "$HOME/.local/share/keyrings"; then
			echo "the keyring file holds the value in the clear" >&2
			exit 1
		fi
		echo "at rest: $(ls "$HOME/.local/share/keyrings") hold no stored value in the clear"
		secret-tool clear app gentle-dot-test
		# The same keyring, locked: a put needs an unlock prompt that cannot be shown here.
		gnome-keyring-daemon --replace --components=secrets >/dev/null 2>&1 </dev/null
		sleep 1
		ignored secure_store::linux::tests::a_locked_keyring_is_refused_without_waiting_on_a_prompt
	'
)

step "App channel: a real Node daemon stand-in keeps fd 3 from its children (Rust spawn)"
cargo test --lib -- --ignored --exact daemon::tests::a_node_daemon_keeps_the_channel_from_its_children

step "App channel: the daemon's own fd 3 test (vitest)"
cd /work
pnpm install --frozen-lockfile --store-dir /pnpm-store >/dev/null
pnpm exec vitest run packages/daemon/test/app-channel-fd.test.ts

step "All Linux checks passed"

#!/usr/bin/env bash
# Runs inside gentle-dot-linux-builder (see Dockerfile). Copies the working tree mounted at /src,
# stages the runtime for this container's architecture (S29.5), builds the .deb with Tauri, and
# leaves it with the runtime's MANIFEST.json in /out (an empty folder). Optional: ENGRAM_VERSION=x.y.z.
# Opt-in Niri/Waybar tray: GENTLE_DOT_KSNI_TRAY=1 (set only by package-linux.mjs --ksni-tray).
set -euo pipefail

case "$(dpkg --print-architecture)" in
arm64) target=linux-arm64 ;;
amd64) target=linux-x64 ;;
*)
	echo "build-deb: unsupported architecture $(dpkg --print-architecture)" >&2
	exit 1
	;;
esac
runtime=/work/build/runtime/linux
step() { printf '\n==> %s (%s s)\n' "$1" "$SECONDS"; }

step "Copying the working tree from /src (tracked and untracked files, minus .gitignore)"
cd /src
# Files deleted in the working tree but still in the index are skipped (--ignore-failed-read).
git ls-files -z --cached --others --exclude-standard -- . ':!:.codegraph' ':!:.atl' |
	tar --null --files-from=- --ignore-failed-read -cf - 2>/dev/null | tar -xf - -C /work
cp -a /src/.git /work/.git
cd /work

step "pnpm install"
pnpm install --frozen-lockfile --store-dir /pnpm-store

step "Staging the $target runtime"
node scripts/package/stage-runtime.mjs --target "$target" --out "$runtime" \
	${ENGRAM_VERSION:+--engram-version "$ENGRAM_VERSION"}

step "Building the .deb"
# The runtime is mapped here rather than in tauri.linux.conf.json: Tauri merges that file into
# every Linux build, and tauri-build fails when a resource is missing, as in source builds.
resources="{\"bundle\":{\"resources\":{\"$runtime/\":\"runtime/\"}}}"
# Opt-in StatusNotifier (KSNI) tray backend for desktops whose tray speaks StatusNotifier but
# not AppIndicator (Niri/Waybar). package-linux.mjs exports GENTLE_DOT_KSNI_TRAY=1 only with
# --ksni-tray; default builds omit --features and keep the AppIndicator backend everywhere.
ksni_features=()
if [ "${GENTLE_DOT_KSNI_TRAY:-0}" = "1" ]; then
	ksni_features=(--features ksni-tray)
	echo "building with the opt-in ksni-tray feature (StatusNotifier backend)"
fi
pnpm --filter @gentle-dot/desktop tauri build --bundles deb "${ksni_features[@]}" --config "$resources"

step "Checking the result"
binary=apps/desktop/src-tauri/target/release/gentle-dot
deb=$(find apps/desktop/src-tauri/target/release/bundle/deb -maxdepth 1 -name '*.deb' -newer "$runtime/MANIFEST.json")
[ "$(printf '%s\n' "$deb" | grep -c .)" = 1 ] || {
	echo "build-deb: expected one new .deb, found: ${deb:-none}" >&2
	exit 1
}
if ldd "$binary" | grep 'not found'; then
	echo "build-deb: the binary has unresolved libraries" >&2
	exit 1
fi
echo "newest glibc symbol the binary needs: $(objdump -T "$binary" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)"
dpkg-deb --info "$deb"
echo "files in the package: $(dpkg-deb --contents "$deb" | wc -l)"
echo "files in the staged runtime: $(find "$runtime" -type f | wc -l)"

cp "$deb" /out/
cp "$runtime/MANIFEST.json" /out/runtime-MANIFEST.json
step "Done: /out/$(basename "$deb")"

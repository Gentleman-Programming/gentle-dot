#!/usr/bin/env bash
# Runs inside gentle-dot-arch-builder: /build holds a filled-in PKGBUILD and the .deb it names.
# makepkg refuses to run as root, so it runs as `builder` on a copy; the package lands in /build.
set -euo pipefail

work=$(mktemp -d /home/builder/pkg.XXXXXX)
cp /build/PKGBUILD /build/*.deb "$work"/
chown -R builder: "$work"
cd "$work"
# The dependencies matter on install, not here: the .deb is only unpacked.
runuser -u builder -- makepkg --nodeps --noconfirm --cleanbuild
pkg=$(find "$work" -maxdepth 1 -name 'gentle-dot-*.pkg.tar.zst')
pacman -Qip "$pkg"
echo "files in the package: $(bsdtar -tf "$pkg" | wc -l)"
cp "$pkg" /build/

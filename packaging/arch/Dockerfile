# makepkg in a container, for the Arch package (packaging/arch/PKGBUILD). The official archlinux
# image is amd64-only. Driven by scripts/package/package-linux.mjs:
#   docker build --platform linux/amd64 -t gentle-dot-arch-builder:latest packaging/arch
FROM archlinux:latest

# pacman's download sandbox fails under emulation ("error restricting syscalls via seccomp: 22"),
# as on an Apple Silicon Mac; it is turned off in this throwaway build image only.
RUN sed -i '/^\[options\]/a DisableSandbox' /etc/pacman.conf \
	&& pacman -Syu --noconfirm --needed base-devel \
	&& pacman -Scc --noconfirm \
	&& useradd --create-home builder

COPY build.sh /usr/local/bin/gentle-dot-build-arch

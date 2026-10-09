# Builds Gentle Dot's Linux packages (S29.3). The image holds only the toolchain; the repository
# is mounted read-only at /src and `build-deb.sh` builds from a copy of it. Debian 12 (glibc 2.36)
# sets the oldest glibc the packaged app needs. Driven by scripts/package/package-linux.mjs:
#   docker build --platform linux/arm64 -t gentle-dot-linux-builder:arm64 docker/linux-package
FROM debian:bookworm

ARG NODE_VERSION=24.14.1
ARG PNPM_VERSION=11.5.0
ARG RUST_TOOLCHAIN=stable

ENV DEBIAN_FRONTEND=noninteractive \
	RUSTUP_HOME=/usr/local/rustup \
	CARGO_HOME=/usr/local/cargo \
	COREPACK_HOME=/usr/local/corepack \
	COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
	PATH=/usr/local/cargo/bin:/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Tauri 2 Linux prerequisites (as in scripts/linux/setup-debian.sh), plus git for the runtime's
# daemon commit, and lsof, procps, and Xvfb for smoke runs.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl file git pkg-config wget xz-utils \
		libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
		lsof procps xauth xvfb \
	&& rm -rf /var/lib/apt/lists/*

# Node.js from the official tarball, checked against the release's SHASUMS256.txt.
RUN set -eu; \
	case "$(dpkg --print-architecture)" in \
		arm64) node_arch=arm64 ;; \
		amd64) node_arch=x64 ;; \
		*) echo "unsupported architecture" >&2; exit 1 ;; \
	esac; \
	archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
	cd /tmp; \
	curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"; \
	curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
	grep " ${archive}\$" SHASUMS256.txt | sha256sum -c -; \
	mkdir -p /usr/local/node; \
	tar -xJf "${archive}" -C /usr/local/node --strip-components=1; \
	rm "${archive}" SHASUMS256.txt; \
	corepack enable; \
	corepack install -g "pnpm@${PNPM_VERSION}"; \
	node --version; pnpm --version

RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
		--default-toolchain "${RUST_TOOLCHAIN}" \
	&& rustc --version && cargo --version

RUN git config --system --add safe.directory '*'

COPY build-deb.sh /usr/local/bin/gentle-dot-build-deb
WORKDIR /work

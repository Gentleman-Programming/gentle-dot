# Gentle Dot for a server (for example a HostGator VPS). See docs/deploy-vps.md.

FROM golang:1-bookworm AS engram
RUN go install github.com/Gentleman-Programming/engram/v3/cmd/engram@latest

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/daemon/package.json packages/daemon/
COPY packages/ui/package.json packages/ui/
COPY apps/desktop/package.json apps/desktop/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY tsconfig.base.json ./
RUN pnpm --filter @gentle-dot/ui build

FROM node:24-bookworm-slim
COPY --from=build /app /app
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git tini \
	&& rm -rf /var/lib/apt/lists/* \
	# The engine's first-run setup needs `pi` on PATH; match the version the daemon bundles.
	&& PI_VERSION="$(node -p "require('/app/packages/daemon/node_modules/@earendil-works/pi-coding-agent/package.json').version")" \
	&& npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
	# Server mode (S25.8): the daemon runs as root, the engine as dot, stdio connector servers as dotmcp.
	&& useradd --create-home dot \
	&& useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin dotmcp \
	# The daemon's code stays root's: readable and runnable by all, writable by no one else.
	# gentle-pi installs its gentle-ai binary with mode 0700 during the build; a+rX lets the engine run it.
	&& chown -R root:root /app \
	&& chmod -R a+rX,go-w /app
COPY --from=engram /go/bin/engram /usr/local/bin/engram
COPY docker/entrypoint.sh /usr/local/bin/gentle-dot-entrypoint
WORKDIR /home/dot
ENV GENTLE_DOT_HOST=0.0.0.0 \
	GENTLE_DOT_PORT=4317 \
	GENTLE_DOT_DATA_DIR=/home/dot/.gentle-dot \
	GENTLE_DOT_VPS=1 \
	GENTLE_DOT_ENGINE_USER=dot \
	GENTLE_DOT_CONNECTOR_USER=dotmcp \
	GENTLE_DOT_ENGRAM_DATA_DIR=/home/dot/.engram
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "gentle-dot-entrypoint"]

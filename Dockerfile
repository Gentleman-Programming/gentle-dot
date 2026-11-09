# Gentle Dot for a server (for example a HostGator VPS). See docs/deploy-vps.md.
# The image is self-contained: the host only needs Docker, on any distro
# (Debian, Fedora, Arch, Omarchy) — everything else ships inside the image.

FROM golang:1-bookworm AS engram
RUN go install github.com/Gentleman-Programming/engram/v3/cmd/engram@latest

FROM node:24.14.1-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# Workspace manifests first (layer cache), then the full sources.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/desktop/package.json apps/desktop/
COPY packages/ packages/
# Los tsbuildinfo del host registran estado up-to-date con paths del host;
# dentro del contenedor tsc confiaría en ellos y no emitiría dist.
RUN find . -name "*.tsbuildinfo" -delete
RUN pnpm install --frozen-lockfile

# Protocol + bridges base + the 9 connector bridges + the UI build to dist.
RUN pnpm --filter @gentle-dot/protocol build \
	&& pnpm --filter @gentle-dot/bridges-base build \
	&& pnpm --filter "@gentle-dot/connectors-*" build \
	&& pnpm --filter @gentle-dot/ui build

FROM node:24.14.1-bookworm-slim
# Solo lo que el daemon necesita: su fuente (corre con tsx) + protocol/bridges
# construidos. Los bridges conectan desde el host u otros contenedores.
COPY --from=build /app/packages/daemon /app/packages/daemon
COPY --from=build /app/packages/protocol /app/packages/protocol
COPY --from=build /app/packages/bridges /app/packages/bridges
COPY --from=build /app/tsconfig.base.json /app/tsconfig.base.json
COPY --from=build /app/node_modules /app/node_modules
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git tini \
	&& rm -rf /var/lib/apt/lists/* \
	# The engine's first-run setup needs `pi` on PATH; match the version the daemon bundles.
	&& PI_VERSION="$(node -p "require('/app/packages/daemon/node_modules/@earendil-works/pi-coding-agent/package.json').version")" \
	&& npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
	# The spawner resolves 'gentle-shell' from PATH: expose the bundled launcher.
	&& ln -s /app/packages/daemon/node_modules/gentle-pi/bin/gentle-shell.mjs /usr/local/bin/gentle-shell \
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
	GENTLE_DOT_ENGRAM_DATA_DIR=/home/dot/.engram \
	GENTLE_DOT_AGENT_HOME=/home/dot/.gentle-dot/agent \
	GENTLE_DOT_ENGINE_MODEL=nan/glm5.3
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4317/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "gentle-dot-entrypoint"]

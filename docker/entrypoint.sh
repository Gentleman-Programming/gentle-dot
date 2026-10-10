#!/bin/sh
# Starts the Gentle Dot daemon in the foreground, as root inside the container: in server mode
# (GENTLE_DOT_VPS=1, docs/deploy-vps.md) it starts the engine as dot and stdio connector servers as
# dotmcp, and keeps its own files out of their reach. The engine starts its own memory server.
set -eu
mkdir -p "$GENTLE_DOT_DATA_DIR"
if [ "${GENTLE_DOT_VPS:-}" = "1" ]; then
	# The volume's root is root's (an older image gave it to dot), so the engine cannot move the data
	# folder. Nothing of the engine runs yet, so handing its memory folder over here cannot race it.
	volume="$(dirname "$GENTLE_DOT_DATA_DIR")"
	chown root:root "$volume"
	chmod 0755 "$volume"
	mkdir -p "$GENTLE_DOT_ENGRAM_DATA_DIR"
	chown -R -P dot:dot "$GENTLE_DOT_ENGRAM_DATA_DIR"
fi
exec node /app/packages/daemon/src/cli.ts

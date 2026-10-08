#!/bin/sh
# Starts the memory server, then the Gentle Dot daemon in the foreground.
set -eu
mkdir -p "$GENTLE_DOT_DATA_DIR" "$GENTLE_DOT_WORKSPACE"
if command -v engram >/dev/null 2>&1; then
	engram serve >"$GENTLE_DOT_DATA_DIR/engram.log" 2>&1 &
fi
exec node /app/packages/daemon/src/cli.ts

#!/bin/sh
# Starts the Gentle Dot daemon in the foreground. The engine starts its own memory server.
set -eu
mkdir -p "$GENTLE_DOT_DATA_DIR" "$GENTLE_DOT_WORKSPACE"
exec node /app/packages/daemon/src/cli.ts

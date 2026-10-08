#!/bin/sh
# Starts the Gentle Dot daemon in the foreground. The engine starts its own memory server.
set -eu
mkdir -p "$GENTLE_DOT_DATA_DIR"
exec node /app/packages/daemon/src/cli.ts

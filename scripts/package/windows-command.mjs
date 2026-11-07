import crossSpawn from "cross-spawn";

/** Launch pnpm's .cmd shim on Windows without losing JSON quoting; native binaries stay native. */
export function spawnCommandSync(command, args, options) {
	return crossSpawn.sync(command, args, options);
}

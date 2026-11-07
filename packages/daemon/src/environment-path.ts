/** Returns a child environment with one Windows PATH and the bundled directory first. */
export function environmentPath(
	base: NodeJS.ProcessEnv,
	bin: string | undefined,
	platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
	const env = { ...base };
	const windows = platform === "win32";
	let path = env.PATH;
	if (windows) {
		// Match Windows child-process precedence, not the object's insertion order.
		const keys = Object.keys(env)
			.filter((key) => key.toUpperCase() === "PATH")
			.sort();
		path = keys.map((key) => env[key]).find((value) => value !== undefined);
		for (const key of keys) delete env[key];
		if (path !== undefined) env.PATH = path;
	}
	if (bin) {
		const separator = windows ? ";" : ":";
		const same = (part: string) =>
			windows
				? part.replace(/[\\/]+$/, "").toLowerCase() === bin.replace(/[\\/]+$/, "").toLowerCase()
				: part === bin;
		// Remove only the bundled directory; preserve the order and duplicates of all others.
		const rest = (path ?? "").split(separator).filter((part) => part && !same(part));
		env.PATH = [bin, ...rest].join(separator);
	}
	return env;
}

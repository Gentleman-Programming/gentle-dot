import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { win32 } from "node:path";

export const DISCORD_CACHE_UNAVAILABLE =
	"Discord cached server is unavailable or ambiguous. No download or retry was attempted.";
interface CacheFiles {
	stat(path: string): Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink" | "nlink" | "size">;
	entries(path: string): string[];
	read(path: string): string;
}
const files: CacheFiles = {
	stat: (path) => lstatSync(path),
	entries: (path) => readdirSync(path),
	read: (path) => readFileSync(path, "utf8"),
};

/** Resolve only the already-installed, exact package. Never execute npm or repair its cache. */
function cachedEntry(localAppData: string | undefined, io: CacheFiles): string {
	try {
		if (!localAppData || !/^[A-Za-z]:[\\/]/.test(localAppData)) throw new Error();
		const root = win32.join(localAppData, "npm-cache", "_npx");
		function guard(path: string, file = false) {
			let node = io.stat(path);
			if (node.isSymbolicLink() || (file ? !node.isFile() || node.nlink !== 1 : !node.isDirectory()))
				throw new Error();
			for (let parent = win32.dirname(path); parent !== path; path = parent, parent = win32.dirname(parent)) {
				node = io.stat(parent);
				if (node.isSymbolicLink() || !node.isDirectory()) throw new Error();
			}
		}
		guard(root);
		const directories = io.entries(root);
		if (directories.length > 64) throw new Error();
		const candidates: string[] = [];
		for (const directory of directories) {
			if (!/^[a-fA-F0-9]{16}$/.test(directory)) continue;
			const pkg = win32.join(root, directory, "node_modules", "@pasympa", "discord-mcp");
			const manifest = win32.join(pkg, "package.json");
			try {
				guard(manifest, true);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (io.stat(manifest).size > 32768) throw new Error();
			const text = io.read(manifest);
			if (Buffer.byteLength(text) > 32768) throw new Error();
			const metadata = JSON.parse(text);
			if (metadata?.name !== "@pasympa/discord-mcp" || metadata.version !== "2.2.0") continue;
			const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.["discord-mcp"];
			if (bin !== "dist/index.js") throw new Error();
			const entry = win32.join(pkg, "dist", "index.js");
			guard(entry, true);
			candidates.push(entry);
			if (candidates.length > 1) throw new Error();
		}
		if (candidates.length !== 1) throw new Error();
		return candidates[0]!;
	} catch {
		// Never repeat paths, metadata or filesystem errors into a proxy response or diagnostic.
		throw new Error(DISCORD_CACHE_UNAVAILABLE);
	}
}

/** Resolve only the approved Windows Discord default; never mutate arguments or environment. */
export function discordStdioLaunch(
	id: string,
	command: string,
	args: readonly string[],
	platform: string,
	programFiles?: string,
	localAppData?: string,
	io: CacheFiles = files,
): { command: string; args: string[] } {
	if (platform !== "win32" || id !== "discord" || command !== "npx") return { command, args: [...args] };
	const root = programFiles && /^[A-Za-z]:[\\/]/.test(programFiles) ? programFiles : "C:\\Program Files";
	const nodeDir = win32.join(root, "nodejs");
	if (args.length === 2 && args[0] === "-y" && args[1] === "@pasympa/discord-mcp@2.2.0")
		return { command: win32.join(nodeDir, "node.exe"), args: [cachedEntry(localAppData, io)] };
	// Preserve non-default argument/command contracts rather than interpreting custom launches.
	return {
		command: win32.join(nodeDir, "node.exe"),
		args: [win32.join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"), ...args],
	};
}

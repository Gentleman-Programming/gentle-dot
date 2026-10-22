import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDir } from "./runtime.ts";

/** Installed mode is bound to its packaged runtime; source mode is bound to this checkout. */
export function windowsPrivateStorageExecutable(runtime = runtimeDir(), moduleUrl = import.meta.url): string {
	if (runtime) return join(runtime, "bin", "private-storage.exe");
	const repositoryRoot = fileURLToPath(new URL("../../../", moduleUrl));
	return join(repositoryRoot, "build", "windows", "local-tools", "bin", "private-storage.exe");
}

/** Invoke the packaged, narrowly-scoped native Windows private-storage boundary. */
export function windowsPrivateStorage(
	operation: "ensure-dir" | "secure-file" | "write-file",
	path: string,
	input?: Buffer,
): void {
	const runtime = runtimeDir();
	const executable = windowsPrivateStorageExecutable(runtime);
	if (!existsSync(executable))
		throw new Error(
			runtime
				? "The Windows private-storage helper is missing from this runtime; private data was not read or written."
				: "The local Windows private-storage helper is missing; run `pnpm prepare:windows-private-storage` from the repository root. Private data was not read or written.",
		);
	try {
		execFileSync(executable, [operation, path], {
			input,
			stdio: ["pipe", "ignore", "pipe"],
			windowsHide: true,
			timeout: 15_000,
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		const stderr = (error as Error & { stderr?: Buffer | string }).stderr;
		const detail = Buffer.isBuffer(stderr)
			? stderr.toString("utf8").trim()
			: stderr || (error as Error).message;
		throw new Error(`Windows private-storage ${operation} failed: ${detail}`);
	}
}

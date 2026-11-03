import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

export interface ArtifactPin {
	kind: "eyes" | "hands";
	version: string;
	entry: string;
	archiveSize: number;
	archiveSha256: string;
	entrySha256: string;
}
export interface AcquiredComponent {
	archivePath: string;
	executablePath: string;
}
export interface ComputerProviderOptions {
	platform?: NodeJS.Platform;
	arch?: string;
	components?: Partial<Record<"eyes" | "hands", AcquiredComponent>>;
}

// Archive pins: build/windows/computer-factory-research/arise-distribution-0.2.1/manifests.json
// and build/windows/inputcontrol-dot-build-0.2.1-dot.1/out/manifest.json. No upstream hands fallback.
// Eyes entry hash was derived statically from the unique screenview-mcp.exe entry
// in the SHA256-verified archive (Python zipfile/hashlib; no extraction/execution).
export const COMPUTER_ARTIFACTS: readonly Readonly<ArtifactPin>[] = Object.freeze([
	Object.freeze({
		kind: "eyes",
		version: "0.2.1",
		entry: "screenview-mcp.exe",
		archiveSize: 38900095,
		archiveSha256: "5903547b9cdec9463ed848cf4e2a2fc6928af47fa4d166eba240776ec410e17d",
		entrySha256: "1c879efe55bdc543eec68b464a4fcaf879da95e6b660752a2b76bd66c21e10dd",
	}),
	Object.freeze({
		kind: "hands",
		version: "0.2.1-dot.1",
		entry: "gentle-dot-inputcontrol.exe",
		archiveSize: 23415547,
		archiveSha256: "59acec247710eb06cd49b678d4a80ae84fcbcf4e7d4255a79437862b2dc3be07",
		entrySha256: "b6945f388eba47e95e959b3d8a7ab2103d25cb64fa417ae893507ff689ff0a11",
	}),
]);

export type ComputerProviderKind = "windows-managed" | "native-macos" | "none";
export interface ComputerProviderStatus {
	status: "ready" | "unavailable";
	kind: ComputerProviderKind;
}
export type ComputerProviderResult =
	| { status: "unavailable"; kind: ComputerProviderKind }
	| {
			status: "ready";
			kind: "windows-managed";
			providers: { kind: "eyes" | "hands"; version: string; executablePath: string }[];
		};

async function matches(path: string, sha256: string, size?: number): Promise<boolean> {
	if (!isAbsolute(path)) return false;
	const stat = await lstat(path);
	if (!stat.isFile() || (size !== undefined && stat.size !== size)) return false;
	return createHash("sha256").update(await readFile(path)).digest("hex") === sha256;
}

/** Preparation only, never a session grant. Expected records are a deterministic test seam;
 * daemon composition always uses fixed production pins. Host paths are never model inputs.
 * Later activation must revalidate files and bind ownership before using the existing McpProxy.
 */
export async function resolveComputerProviders(
	options: ComputerProviderOptions = {},
	pins: readonly ArtifactPin[] = COMPUTER_ARTIFACTS,
): Promise<ComputerProviderResult> {
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") return { status: "unavailable", kind: "native-macos" };
	if (platform !== "win32" || (options.arch ?? process.arch) !== "x64")
		return { status: "unavailable", kind: "none" };
	const unavailable = { status: "unavailable", kind: "windows-managed" } as const;
	try {
		if (pins.length !== 2 || pins[0]?.kind !== "eyes" || pins[1]?.kind !== "hands") return unavailable;
		const providers = [];
		for (const pin of pins) {
			const component = options.components?.[pin.kind];
			if (
				!component ||
				basename(component.executablePath) !== pin.entry ||
				!(await matches(component.archivePath, pin.archiveSha256, pin.archiveSize)) ||
				!(await matches(component.executablePath, pin.entrySha256))
			) return unavailable;
			providers.push({ kind: pin.kind, version: pin.version, executablePath: component.executablePath });
		}
		return { status: "ready", kind: "windows-managed", providers };
	} catch {
		// No local paths or filesystem errors cross the status boundary.
		return unavailable;
	}
}

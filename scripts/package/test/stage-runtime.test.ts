import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	PI_CODEMODE,
	PI_CODEMODE_VERSION,
	pinDaemonDependency,
} from "../stage-runtime.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const scratch = (prefix: string) => mkdtempSync(join(REPO, "build", prefix));

function stagedDaemon(manifest: Record<string, unknown>) {
	const dir = scratch(".tmp-stage-pin-");
	const daemon = join(dir, "daemon");
	mkdirSync(daemon, { recursive: true });
	writeFileSync(join(daemon, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	return { dir, daemon };
}

describe("pinDaemonDependency", () => {
	it("pins the codemode release the bundled engine still matches", () => {
		expect(PI_CODEMODE).toBe("@earendil-works/pi-codemode");
		expect(PI_CODEMODE_VERSION).toBe("1.1.0");
	});

	it("writes an npm overrides pin into the staged daemon manifest", () => {
		const { dir, daemon } = stagedDaemon({
			name: "daemon-stub",
			version: "0.0.0",
			dependencies: { lefthook: "1.0.0" },
		});
		try {
			pinDaemonDependency(daemon, PI_CODEMODE, PI_CODEMODE_VERSION);
			const manifest = JSON.parse(readFileSync(join(daemon, "package.json"), "utf8"));
			expect(manifest.overrides).toEqual({ "@earendil-works/pi-codemode": "1.1.0" });
			expect(manifest.dependencies).toEqual({ lefthook: "1.0.0" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("merges with existing overrides instead of replacing them", () => {
		const { dir, daemon } = stagedDaemon({
			name: "daemon-stub",
			overrides: { "some-dep": "2.0.0" },
		});
		try {
			pinDaemonDependency(daemon, PI_CODEMODE, PI_CODEMODE_VERSION);
			expect(JSON.parse(readFileSync(join(daemon, "package.json"), "utf8")).overrides).toEqual({
				"some-dep": "2.0.0",
				"@earendil-works/pi-codemode": "1.1.0",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails loudly when the staged daemon has no manifest to pin", () => {
		const dir = scratch(".tmp-stage-pin-");
		try {
			expect(() =>
				pinDaemonDependency(join(dir, "daemon"), PI_CODEMODE, PI_CODEMODE_VERSION),
			).toThrow(/staged daemon has no .* to pin @earendil-works\/pi-codemode in/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

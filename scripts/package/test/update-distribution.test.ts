import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../collect-macos-qa.mjs", import.meta.url));
const folders: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "dot-update-test-"));
	folders.push(root);
	const write = (file: string, data: string) => {
		const path = join(root, file);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, data);
	};
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"--allow-empty",
			"-qm",
			"fixture",
		],
		{ cwd: root },
	);
	write(
		"apps/desktop/src-tauri/tauri.conf.json",
		JSON.stringify({ productName: "Gentle Dot", version: "0.1.0" }),
	);
	write("apps/desktop/src-tauri/target/release/bundle/dmg/Gentle Dot_0.1.0_aarch64.dmg", "fixture-dmg");
	write("apps/desktop/src-tauri/target/release/bundle/macos/Gentle Dot.app.tar.gz", "fixture-update");
	write("apps/desktop/src-tauri/target/release/bundle/macos/Gentle Dot.app.tar.gz.sig", "fixture-signature");
	write("build/runtime/darwin-arm64/MANIFEST.json", JSON.stringify({ target: "darwin-arm64" }));
	write("LICENSE", "fixture-license");
	return {
		root,
		write,
		run: (tag = "macos-qa-v0.1.0-1") =>
			spawnSync(process.execPath, [script], {
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					GITHUB_REF_TYPE: "tag",
					GITHUB_REF_NAME: tag,
					GITHUB_REPOSITORY: "Maicololiveras/gentle-dot",
				},
			}),
	};
}
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
it("ties the feed to the release and checksums every output", () => {
	const f = fixture();
	expect(f.run().status).toBe(0);
	const output = join(f.root, "dist/macos-qa");
	const feed = JSON.parse(readFileSync(join(output, "latest.json"), "utf8"));
	expect(feed.version).toBe("0.1.0");
	expect(feed.platforms["darwin-aarch64"].url).toBe(
		"https://github.com/Maicololiveras/gentle-dot/releases/download/macos-qa-v0.1.0-1/Gentle%20Dot.app.tar.gz",
	);
	for (const line of readFileSync(join(output, "SHA256SUMS"), "utf8").trim().split("\n")) {
		const [hash, name] = line.split("  ");
		expect(
			createHash("sha256")
				.update(readFileSync(join(output, name)))
				.digest("hex"),
		).toBe(hash);
	}
	expect(f.run().status).not.toBe(0);
});
it("rejects a tag that disagrees with the app version", () => {
	expect(fixture().run("macos-qa-v0.2.0-1").status).not.toBe(0);
});
it("rejects an empty updater signature", () => {
	const f = fixture();
	f.write("apps/desktop/src-tauri/target/release/bundle/macos/Gentle Dot.app.tar.gz.sig", "");
	expect(f.run().status).not.toBe(0);
});
it("rejects a stable tag in the QA pipeline", () => {
	expect(fixture().run("v0.1.0").status).not.toBe(0);
});

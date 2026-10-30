// Collect only public build outputs; never include HOME, keychains or runtime logs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const source = "apps/desktop/src-tauri/target/release/bundle/dmg";
const output = "dist/macos-qa";
const dmgs = (await readdir(source)).filter((name) => name.endsWith("_aarch64.dmg"));
if (dmgs.length !== 1) throw new Error(`Expected exactly one ARM64 DMG, found ${dmgs.length}`);
const manifest = JSON.parse(await readFile("build/runtime/darwin-arm64/MANIFEST.json", "utf8"));
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error("Output must be empty to prevent stale release assets");
await cp(join(source, dmgs[0]), join(output, dmgs[0]));
await cp("LICENSE", join(output, "LICENSE.txt"));
const info = {
	sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	repository: process.env.GITHUB_REPOSITORY ?? null,
	runId: process.env.GITHUB_RUN_ID ?? null,
	architecture: "arm64",
	signing: "ad-hoc",
	notarized: false,
	runtime: manifest,
};
await writeFile(join(output, "BUILD-INFO.json"), `${JSON.stringify(info, null, 2)}\n`);
const sums = [];
for (const name of (await readdir(output)).sort()) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(join(output, name))) hash.update(chunk);
	sums.push(`${hash.digest("hex")}  ${name}`);
}
await writeFile(join(output, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`Collected ${dmgs[0]} with SHA256SUMS and build provenance`);

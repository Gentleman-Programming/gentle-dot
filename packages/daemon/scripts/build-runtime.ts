// Builds the daemon part of the installed runtime: `build:runtime -- --out <runtime folder>`.
import { resolve } from "node:path";
import { buildRuntime } from "../src/runtime-build.ts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const out = args[args.indexOf("--out") + 1];
if (!args.includes("--out") || !out) {
	process.stderr.write("usage: build-runtime --out <dir>\n");
	process.exit(2);
}
// pnpm runs the script in the package folder; a relative path is the caller's.
await buildRuntime(resolve(process.env.INIT_CWD ?? process.cwd(), out));

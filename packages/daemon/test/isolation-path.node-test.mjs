import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";

// Exercise the public helper, not daemon/SDK startup or the host environment.
// Every filesystem write/probe and default access callback fails closed.
const target = new URL("../src/isolation.ts", import.meta.url).href;
const deny = `()=>{throw Error('Unexpected filesystem or SDK operation')}`;
const modules = new Map([
	[
		"node:fs",
		`const deny=${deny}; export const chmodSync=deny,mkdirSync=deny,readFileSync=deny,renameSync=deny,writeFileSync=deny,existsSync=()=>false;`,
	],
	["node:module", "export const createRequire=()=>({resolve:{paths:()=>[]}});"],
	["./config.ts", `export const bundledGentleShell=${deny};`],
	["./engine-access.ts", `export const directAccess=${deny};`],
	["./windows-runtime.ts", "export const windowsUserHome=()=>undefined;"],
	["./windows-private-storage.ts", `export const windowsPrivateStorage=${deny};`],
	["./private-file.ts", `export const writePrivateFile=${deny};`],
	[
		"./runtime.ts",
		"export const runtimeDir=e=>e.GENTLE_DOT_RUNTIME; export const resolveEngramBin=e=>e.ENGRAM_BIN;",
	],
]);
registerHooks({
	resolve(specifier, context, next) {
		if (context.parentURL === target) {
			if (specifier === "./environment-path.ts") return next(specifier, context);
			if (modules.has(specifier))
				return {
					url: "data:text/javascript," + encodeURIComponent(modules.get(specifier)),
					shortCircuit: true,
				};
			if (!specifier.startsWith("node:")) throw Error("Unapproved dependency");
		}
		return next(specifier, context);
	},
});
const { isolatedAgentEnv } = await import(target);
const runtime = "/synthetic-runtime";
const bin = join(runtime, "bin");
const data = "/synthetic-data";
const inherited = "C:\\Users\\synthetic\\scoop\\shims;C:\\Windows\\System32";
const fixture = {
	HOME: "/synthetic-user",
	TMPDIR: "/synthetic-temp",
	GENTLE_DOT_RUNTIME: runtime,
	ENGRAM_BIN: "/synthetic-engram",
};
const pathKeys = (env) => Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
function run(extra, platform = "win32") {
	const base = Object.freeze({ ...fixture, ...extra });
	const before = { ...base };
	let suppressed = 0;
	const env = isolatedAgentEnv(
		base,
		data,
		() => {
			suppressed++;
		},
		{ platform },
	);
	assert.deepEqual(base, before, "input stays immutable");
	assert.equal(
		suppressed,
		platform === "win32" ? 2 : 1,
		"home access callback suppressed; no filesystem mutation",
	);
	return env;
}

test("Windows preserves inherited entries for every PATH casing with one output key", () => {
	for (const key of ["Path", "PATH", "path", "pAtH"]) {
		const env = run({ [key]: inherited });
		assert.deepEqual(pathKeys(env), ["PATH"]);
		assert.equal(env.PATH, `${bin};${inherited}`);
	}
});

test("Windows duplicate keys select the first lexicographic key, independent of insertion order", () => {
	for (const paths of [
		{ Path: "IGNORED_MIXED", path: "IGNORED_LOWER", PATH: inherited },
		{ PATH: inherited, path: "IGNORED_LOWER", Path: "IGNORED_MIXED" },
		{ path: "IGNORED_LOWER", Path: inherited },
	]) {
		const env = run(paths);
		assert.deepEqual(pathKeys(env), ["PATH"]);
		assert.equal(env.PATH, `${bin};${inherited}`);
	}
});

test("Windows normalizes inherited keys even without a bundled bin", () => {
	const env = run({ GENTLE_DOT_RUNTIME: undefined, Path: inherited, path: "IGNORED_LOWER" });
	assert.deepEqual(pathKeys(env), ["PATH"]);
	assert.equal(env.PATH, inherited);
});

test("Windows retains bundled prepend, deduplication and empty/missing fallback", () => {
	for (const path of [undefined, ""]) assert.equal(run({ PATH: path }).PATH, bin);
	const once = run({ PATH: `${inherited};${bin}` });
	assert.equal(once.PATH, `${bin};${inherited}`);
	assert.equal(run({ PATH: once.PATH }).PATH, once.PATH);
});

test("POSIX preserves distinct Path variables and previous prepend/idempotence behavior", () => {
	const env = run({ PATH: "/user tools:/usr/bin", Path: "POSIX_CASE_SENSITIVE_VALUE" }, "linux");
	assert.equal(env.PATH, `${bin}:/user tools:/usr/bin`);
	assert.equal(env.Path, "POSIX_CASE_SENSITIVE_VALUE");
	assert.equal(run({ PATH: env.PATH }, "linux").PATH, env.PATH);
	assert.equal(run({ Path: "POSIX_CASE_SENSITIVE_VALUE" }, "linux").PATH, bin);
	assert.equal(
		run({ GENTLE_DOT_RUNTIME: undefined, Path: "POSIX_CASE_SENSITIVE_VALUE" }, "linux").PATH,
		undefined,
	);
});

test("PATH normalization does not change existing home, memory or daemon-secret filtering", () => {
	const env = run({ Path: inherited, GENTLE_DOT_SECRETS_KEY: "SYNTHETIC_SECRET" });
	const { PATH, ...other } = env;
	assert.equal(PATH, `${bin};${inherited}`);
	const home = join(data, "home");
	assert.deepEqual(other, {
		...fixture,
		HOME: home,
		USERPROFILE: home,
		TEMP: join(home, ".cache", "tmp"),
		TMP: join(home, ".cache", "tmp"),
		TMPDIR: join(home, ".cache", "tmp"),
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		GENTLE_PI_AGENTS: "1",
		ENGRAM_DATA_DIR: join(fixture.HOME, ".engram"),
	});
});

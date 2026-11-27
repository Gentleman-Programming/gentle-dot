import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentSpawnEnv } from "../../../packages/daemon/src/config.ts";
import {
	lockedDependencies,
	lockedEnginePackages,
} from "../../../packages/daemon/src/runtime-build.ts";

const source = JSON.parse(
	readFileSync(new URL("../../../packages/daemon/package.json", import.meta.url), "utf8"),
);

test("selects Gentle Shell 5.0.0 in both source and packaged runtime dependencies", () => {
	assert.equal(source.dependencies["gentle-pi"], "5.0.0");
	assert.equal(lockedDependencies()["gentle-pi"], "5.0.0");
});

test("retains exact matching SDK dependencies and runtime sibling overrides", () => {
	const direct = lockedDependencies();
	for (const name of ["pi-ai", "pi-coding-agent", "pi-mcp", "pi-tui"]) {
		const dependency = `@earendil-works/${name}`;
		assert.equal(source.dependencies[dependency], "1.6.0");
		assert.equal(direct[dependency], source.dependencies[dependency]);
	}
	const version = direct["@earendil-works/pi-coding-agent"];
	assert.deepEqual(lockedEnginePackages(direct), {
		"@earendil-works/pi-agent-core": version,
		"@earendil-works/pi-codemode": version,
		"@earendil-works/pi-schema": version,
		"@earendil-works/pi-telemetry": version,
	});
});

const runtime = fileURLToPath(new URL("../../../build/compatibility-fixture-runtime", import.meta.url));
const script = join(runtime, "daemon", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
const inherited = {
	GENTLE_DOT_RUNTIME: runtime,
	GENTLE_SHELL_INTERACTIVE_HOST: "1",
	GENTLE_SHELL_NO_AUTO_SETUP: "0",
	GENTLE_PI_SKIP_GENTLE_AI_INSTALL: "0",
	NODE_OPTIONS: "fixture-security-binding",
	GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "fixture-permission-binding",
};

test("keeps the bundled RPC engine headless despite an inherited interactive-host opt-in", () => {
	const before = { ...inherited };
	for (const platform of ["win32", "linux", "darwin"]) {
		const actual = agentSpawnEnv(process.execPath, [script], inherited, platform);
		const expected = { ...inherited };
		delete expected.GENTLE_SHELL_INTERACTIVE_HOST;
		if (platform === "win32") {
			expected.GENTLE_SHELL_NO_AUTO_SETUP = "1";
			expected.GENTLE_PI_SKIP_GENTLE_AI_INSTALL = "1";
		}
		assert.deepEqual(actual, expected);
		assert.deepEqual(inherited, before);
	}
});

test("preserves custom-agent inheritance and existing platform provisioning gates", () => {
	for (const platform of ["win32", "linux", "darwin"]) {
		for (const override of [
			{ GENTLE_DOT_AGENT_BIN: process.execPath },
			{ GENTLE_DOT_AGENT_SCRIPT: script },
			{ GENTLE_DOT_AGENT_ARGS: "[]" },
		]) {
			const env = { ...inherited, ...override };
			assert.equal(agentSpawnEnv(process.execPath, [script], env, platform), env);
		}
		assert.equal(agentSpawnEnv("custom-node", [script], inherited, platform), inherited);
		assert.equal(agentSpawnEnv(process.execPath, ["custom-agent.mjs"], inherited, platform), inherited);
		const env = { ...inherited };
		delete env.GENTLE_SHELL_INTERACTIVE_HOST;
		assert.deepEqual(agentSpawnEnv(process.execPath, [script], env, platform), {
			...env,
			...(platform === "win32" ? {
				GENTLE_SHELL_NO_AUTO_SETUP: "1",
				GENTLE_PI_SKIP_GENTLE_AI_INSTALL: "1",
			} : {}),
		});
	}
});

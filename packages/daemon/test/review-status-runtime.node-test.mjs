import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import * as sdk from "gentle-pi/runtime/native-review-cli.mjs";
import { registerReviewStatus, reviewClientFromModule } from "../src/extensions/review-status.ts";

// Actual generated factory/decoder, but an inert executor and explicit nonexistent
// executable: no child process, default binary resolver, provider or profile access.
const require = createRequire(import.meta.url);
const version = JSON.parse(readFileSync(require.resolve("gentle-pi/package.json"), "utf8")).version;
const cwd = realpathSync(process.cwd());
const executable = resolve("test-fixtures/never-executed-native");

for (const effective of ["on", "off"]) {
	test(`generated gentle-pi4.6 runtime decodes ${effective} through the unchanged status adapter`, async () => {
		assert.equal(version, "4.6.0");
		assert.equal(typeof sdk.createNativeReviewCli, "function");
		assert.equal(typeof sdk.createNodeExecFileAdapter, "function");
		let executions = 0;
		const signal = new AbortController().signal;
		const client = reviewClientFromModule({
			createNodeExecFileAdapter: () => async (request) => {
				executions++;
				assert.equal(request.file, executable);
				assert.equal(request.cwd, cwd);
				assert.equal(request.signal, signal);
				assert.deepEqual(request.arguments, ["review", "mode", "status", "--cwd", cwd, "--json"]);
				return {
					exitCode: 0,
					stderr: "",
					signal: null,
					timedOut: false,
					outputLimitExceeded: false,
					stdout: JSON.stringify({
						schema: "gentle-ai.review-mode/v1",
						operation: "status",
						scope: "both",
						status: {
							schema: "gentle-ai.rdd-mode-status/v1",
							global: "",
							clone_local: effective,
							effective,
							source: "clone_local",
							reach: "this_build",
							revision: "OMIT_CANARY",
						},
					}),
				};
			},
			createNativeReviewCli: (adapter) => sdk.createNativeReviewCli(adapter, executable),
		});
		let tool;
		registerReviewStatus(
			{
				registerTool: (value) => {
					tool = value;
				},
				on() {},
			},
			{},
			async () => client,
		);
		const result = await tool.execute("fixture", {}, signal, () => assert.fail("no streaming"), { cwd });
		assert.equal(executions, 1);
		assert.deepEqual(result.details, {
			ok: true,
			readOnly: true,
			status: { global: "", cloneLocal: effective, effective, source: "clone_local", reach: "this_build" },
		});
		assert.deepEqual(JSON.parse(result.content[0].text), result.details);
		assert.ok(!JSON.stringify(result).includes("OMIT_CANARY"));
	});
}

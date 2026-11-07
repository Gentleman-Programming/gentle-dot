import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

let desktop = true;
let response;
let failure;
const calls = [];
globalThis.computerBindingFake = {
	isTauri: () => desktop,
	invoke: async (command, args) => {
		calls.push({ command, args });
		if (failure) throw failure;
		return response;
	},
};
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@tauri-apps/api/core")
			return {
				url:
					"data:text/javascript," +
					encodeURIComponent(
						"export const isTauri=()=>globalThis.computerBindingFake.isTauri(); export const invoke=(...args)=>globalThis.computerBindingFake.invoke(...args);",
					),
				shortCircuit: true,
			};
		return next(specifier, context);
	},
});
const binding = await import("../src/computer.ts");

test("binding refuses empty endpoints, preserves transport data only for native registration", async () => {
	response = { url: "", token: "test" };
	assert.equal(await binding.computerEndpoint(), null);
	response = { url: "http://127.0.0.1:1", token: "test" };
	assert.deepEqual(await binding.computerEndpoint(), response);
});
test("prerequisites include screenshot support and never become a session grant", async () => {
	response = { accessibility: true, screenRecording: true, screenshotsSupported: true };
	assert.deepEqual(await binding.computerPermissions(), response);
	response = { active: false, yolo: false };
	assert.deepEqual(await binding.computerStatus(), {});
	response = { active: true, endsAt: 1700000000, yolo: false };
	assert.deepEqual(await binding.computerStatus(), { session: { endsAt: 1700000000000 } });
	response = { active: false, yolo: true, yoloEndsAt: 1700000000 };
	assert.deepEqual(await binding.computerStatus(), { yolo: { endsAt: 1700000000000 } });
	await binding.requestComputerPermission("screenRecording");
	assert.deepEqual(calls.at(-1), {
		command: "computer_request_permission",
		args: { kind: "screenRecording" },
	});
});
test("missing or malformed screenshot support fails closed without losing explicit support", async () => {
	for (const screenshotsSupported of [undefined, null, "true", 1, false, true]) {
		response = {
			accessibility: true,
			screenRecording: true,
			...(screenshotsSupported === undefined ? {} : { screenshotsSupported }),
		};
		assert.deepEqual(await binding.computerPermissions(), {
			accessibility: true,
			screenRecording: true,
			screenshotsSupported: screenshotsSupported === true,
		});
	}
});

test("native panic registration and screenshot refusal reasons survive normalization without invented promises", async () => {
	for (const panicShortcut of [true, false, undefined, "true"]) {
		response = {
			accessibility: true,
			screenRecording: true,
			screenshotsSupported: false,
			panicShortcut,
			screenshotsUnsupported: "unknownVersion",
		};
		const permissions = await binding.computerPermissions();
		assert.equal(permissions.panicShortcut === true, panicShortcut === true);
		assert.equal(permissions.screenshotsUnsupported, "unknownVersion");
	}
	for (const reason of ["tooOld", "unknownVersion", "unexpected", undefined]) {
		response = { screenshotsSupported: false, screenshotsUnsupported: reason };
		assert.equal(
			(await binding.computerPermissions()).screenshotsUnsupported,
			reason === "tooOld" || reason === "unknownVersion" ? reason : undefined,
		);
	}
	response = { screenshotsSupported: true, screenshotsUnsupported: "tooOld" };
	assert.equal((await binding.computerPermissions()).screenshotsUnsupported, undefined);
});

test("Stop and Yolo retain native authority and errors are not converted into readiness", async () => {
	binding.stopComputer();
	assert.deepEqual(calls.at(-1), { command: "computer_stop", args: undefined });
	response = { active: false, yolo: false };
	await binding.setComputerYolo(true);
	assert.deepEqual(calls.at(-1), { command: "computer_set_yolo", args: { enabled: true } });
	assert.deepEqual(await binding.computerStatus(), {});
	failure = new Error("Native prerequisites unavailable");
	await assert.rejects(binding.computerPermissions(), /Native prerequisites unavailable/);
	failure = undefined;
});

test("web/VPS has no native control or prerequisite promise", async () => {
	desktop = false;
	const before = calls.length;
	assert.equal(await binding.computerEndpoint(), null);
	assert.deepEqual(await binding.computerPermissions(), {
		accessibility: false,
		screenRecording: false,
		screenshotsSupported: false,
	});
	assert.deepEqual(await binding.computerStatus(), {});
	await binding.setComputerYolo(true);
	await binding.requestComputerPermission("accessibility");
	binding.stopComputer();
	assert.equal(calls.length, before);
});

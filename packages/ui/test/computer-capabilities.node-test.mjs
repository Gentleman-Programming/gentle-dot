import assert from "node:assert/strict";
import test from "node:test";
import {
	computerCopy,
	computerPermissionKinds,
	computerPlatform,
	computerReadiness,
	observeComputerRegistration,
	registeredComputerEndpoint,
} from "../src/computer-capabilities.ts";

test("registration is not readiness or a session grant", () => {
	const endpoint = { url: "http://127.0.0.1:1", token: "test" };
	assert.equal(registeredComputerEndpoint(endpoint), true);
	assert.equal(computerReadiness(endpoint), false);
	for (const endpoint of [null, {}, { url: "", token: "test" }, { url: "x", token: "" }])
		assert.equal(registeredComputerEndpoint(endpoint), false);
	for (const probe of [
		undefined,
		null,
		false,
		1,
		{},
		{ accessibility: true, screenRecording: true },
		{ accessibility: true, screenRecording: true, screenshotsSupported: false },
		{ accessibility: true, screenRecording: false, screenshotsSupported: true },
		{ accessibility: false, screenRecording: true, screenshotsSupported: true },
		{ accessibility: true, screenRecording: true, screenshotsSupported: "true" },
	])
		assert.equal(computerReadiness(probe), false);
	assert.equal(
		computerReadiness({ accessibility: true, screenRecording: true, screenshotsSupported: true }),
		true,
	);
	assert.deepEqual(computerPermissionKinds, ["accessibility", "screenRecording"]);
});

test("registration observer clears stale availability, ignores late endpoints and treats failure as unavailable", async () => {
	const results = [];
	let resolve;
	const stop = observeComputerRegistration(
		true,
		true,
		() =>
			new Promise((done) => {
				resolve = done;
			}),
		(value) => results.push(value),
	);
	assert.deepEqual(results, [false]);
	stop();
	resolve({ url: "http://127.0.0.1:1", token: "test" });
	await Promise.resolve();
	assert.deepEqual(results, [false]);
	for (const [enabled, connected] of [
		[false, true],
		[true, false],
		[false, false],
	]) {
		observeComputerRegistration(
			enabled,
			connected,
			() => {
				throw Error("disabled must not probe");
			},
			(value) => results.push(value),
		);
		assert.equal(results.at(-1), false);
	}
	observeComputerRegistration(
		true,
		true,
		async () => ({ url: "http://127.0.0.1:1", token: "test" }),
		(value) => results.push(value),
	);
	await Promise.resolve();
	assert.equal(results.at(-1), true);
	observeComputerRegistration(
		true,
		true,
		async () => {
			throw Error("native unavailable");
		},
		(value) => results.push(value),
	);
	await Promise.resolve();
	assert.equal(results.at(-1), false);
});

test("presentation identifies Windows, Mac and unknown explicitly, never non-Mac as Windows", () => {
	assert.equal(computerPlatform("Mozilla Windows NT 10.0"), "windows");
	assert.equal(computerPlatform("Mozilla Macintosh; Intel Mac OS X"), "mac");
	for (const ua of ["", "Linux x86_64", "iPhone", "Android"]) assert.equal(computerPlatform(ua), "unknown");
	assert.match(computerCopy("windows").banner, /Windows PC/);
	assert.equal(computerCopy("windows").panic, "Alt+Shift+Esc");
	assert.match(computerCopy("windows").prerequisites, /not.*session/i);
	assert.match(computerCopy("windows").limits, /running apps/);
	assert.match(computerCopy("mac").banner, /Mac/);
	assert.equal(computerCopy("mac").panic, "⌥⇧Esc");
	assert.doesNotMatch(JSON.stringify(computerCopy("unknown")), /Mac|Windows|Alt\+Shift/);
});

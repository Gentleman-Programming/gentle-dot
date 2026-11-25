// Dependency-free preservation checks for the merge's transport boundary.
// Pure JS orchestration only: no native addon, daemon, provider, or filesystem fixture.
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { AppChannel, inheritedAppSocket, MAX_FRAME } from "../src/app-channel.ts";
import {
	createWindowsAppChannelForTesting,
	isProductionWindowsAppChannel,
	WindowsAppChannel,
} from "../src/windows-app-channel.ts";

// The Unix inherited-socket rule remains in app-channel-fd.test.ts; this check
// exercises the actual Windows dispatch without fabricating a native handle.
test("the legacy stdio selector grants no Windows channel", { skip: process.platform !== "win32" }, () => {
	const saved = process.env.GENTLE_DOT_APP_STDIO;
	process.env.GENTLE_DOT_APP_STDIO = "v1";
	try {
		let probes = 0;
		assert.equal(inheritedAppSocket({ probe: () => { probes++; return false; } }), undefined);
		assert.equal(probes, 0);
		assert.equal(process.env.GENTLE_DOT_APP_STDIO, "v1");
	} finally {
		if (saved === undefined) delete process.env.GENTLE_DOT_APP_STDIO;
		else process.env.GENTLE_DOT_APP_STDIO = saved;
	}
});

test("an injected fake owner cannot mint production admission", async () => {
	let loads = 0;
	const snapshot = {
		phase: "open", error: 0, eof: false, pendingIo: false,
		readableBytes: 0, queuedBytes: 0, queuedItems: 0,
		acceptedWrite: 0n, completedWrite: 0n,
	};
	let releases = 0;
	const loadNative = () => {
		loads++;
		return { adoptAppChannelFd3: () => ({
			status: () => ({ ...snapshot }), poll: () => ({ ...snapshot }),
			read: () => Buffer.alloc(0), write: () => { throw new Error("unexpected write"); },
			stop: () => { snapshot.phase = "closed"; return { ...snapshot }; },
			release: () => { releases++; return { ...snapshot }; },
		}) };
	};
	assert.throws(() => new WindowsAppChannel({ exclusiveFd3Startup: true, loadNative }),
		{ message: "Production app channel does not accept an injected loader" });
	assert.equal(loads, 0);
	const channel = createWindowsAppChannelForTesting(
		{ exclusiveFd3Startup: true, loadNative, closeTimeoutMs: 100 },
		{ platform: "win32", mainThread: true, ipcChannel: false, ipcConnected: false, channelFdPresent: false },
	);
	assert.equal(loads, 1);
	assert.equal(isProductionWindowsAppChannel(channel), false);
	assert.deepEqual(await channel.close("abort"), { mode: "abort", drained: false });
	assert.equal(releases, 1);
	assert.equal(isProductionWindowsAppChannel(channel), false);
});

test("ordinary frames still correlate; oversized requests and closed channels send no bytes", async () => {
	const writes = [];
	const stream = new Duplex({
		read() {},
		write(bytes, _encoding, done) { writes.push(bytes.toString()); done(); },
	});
	const channel = new AppChannel(stream);
	try {
		const answer = channel.request("secret_list", {}, 1000);
		assert.deepEqual(writes, ['{"kind":"request","id":1,"method":"secret_list","params":{}}\n']);
		stream.push('{"kind":"response","id":1,"result":{"ids":["synthetic"]}}\n');
		assert.deepEqual(await answer, { ids: ["synthetic"] });
		await assert.rejects(channel.request("oversized", { text: "x".repeat(MAX_FRAME) }, 1000),
			{ message: "The request oversized is too large for the Gentle Dot app." });
		assert.equal(writes.length, 1);
		assert.equal(channel.connected, true);
		const pending = channel.request("pending", {}, 1000);
		const rejected = assert.rejects(pending, { message: "The Gentle Dot app closed its channel." });
		await channel.close();
		await rejected;
		assert.equal(channel.connected, false);
		assert.equal(stream.destroyed, true);
		await assert.rejects(channel.request("after_close", {}, 1000),
			{ message: "The Gentle Dot app is not connected." });
		assert.equal(writes.length, 2);
	} finally {
		await channel.close();
	}
});

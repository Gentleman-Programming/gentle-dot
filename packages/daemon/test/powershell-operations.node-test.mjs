import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";
import { createPowerShellOperations } from "../src/extensions/powershell-operations.ts";

function processHarness({ taskkillThrows = false } = {}) {
	const calls = [];
	const spawn = (file, args, options) => {
		const child = new EventEmitter();
		child.pid = 101 + calls.length;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdout.destroy = child.stderr.destroy = () => {};
		child.kill = () => {
			child.killed = true;
		};
		calls.push({ file, args, options, child });
		if (taskkillThrows && calls.length === 2) throw new Error("taskkill spawn failed");
		return child;
	};
	const timers = new Map();
	const operations = createPowerShellOperations({
		spawn,
		systemRoot: "C:\\Windows",
		setTimeout: (fn, ms) => {
			const id = {};
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimeout: (id) => timers.delete(id),
	});
	return { calls, timers, operations };
}

test("native argv preserves Unicode/multiline command data, cwd, supplied env and both streams", async () => {
	const h = processHarness();
	const env = Object.freeze({ EXAMPLE: "unchanged" });
	const command = "Write-Output \"π 🚀\"\nWrite-Output 'literal $value'";
	const chunks = [];
	const pending = h.operations.exec(command, "C:\\project with spaces", {
		env,
		onData: (b) => chunks.push(b),
	});
	const call = h.calls[0];
	assert.equal(call.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.deepEqual(call.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
	const decoded = Buffer.from(call.args.at(-1), "base64").toString("utf16le");
	assert.ok(decoded.endsWith(command));
	assert.equal(
		decoded.slice(0, -command.length),
		"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n",
	);
	assert.equal(call.options.env, env);
	assert.equal(call.options.cwd, "C:\\project with spaces");
	assert.equal(call.options.windowsHide, true);
	assert.equal(call.options.shell, false);
	call.child.stdout.emit("data", Buffer.from("π"));
	call.child.stderr.emit("data", Buffer.from("problem"));
	assert.equal(Buffer.concat(chunks).toString(), "πproblem");
	call.child.emit("exit", 7, null);
	call.child.emit("close", 7, null);
	assert.deepEqual(await pending, { exitCode: 7 });
	assert.equal(call.child.stdout.listenerCount("data"), 0);
	assert.equal(h.timers.size, 0);
});

for (const [name, timeout] of [
	["omitted", undefined],
	["zero", 0],
	["negative", -1],
	["NaN", NaN],
	["infinite", Infinity],
	["overflow", 2147484],
]) {
	test(`timeout ${name}: seconds validation without process/environment mutation`, async () => {
		const h = processHarness();
		const promise = h.operations.exec("literal data", "C:\\project", { onData() {}, timeout });
		if (timeout === undefined) {
			assert.equal(h.calls[0].options.env, undefined, "inherit the normal environment");
			h.calls[0].child.emit("close", 0, null);
			assert.deepEqual(await promise, { exitCode: 0 });
		} else {
			await assert.rejects(promise, /Invalid timeout/);
			assert.equal(h.calls.length, 0);
		}
	});
}

test("pre-abort never spawns and spawn failures propagate", async () => {
	const h = processHarness();
	await assert.rejects(
		h.operations.exec("data", "cwd", { onData() {}, signal: AbortSignal.abort() }),
		/aborted/,
	);
	assert.equal(h.calls.length, 0);
	const p = h.operations.exec("data", "cwd", { onData() {} });
	const error = new Error("spawn denied");
	h.calls[0].child.emit("error", error);
	await assert.rejects(p, (e) => e === error);
	assert.equal(h.calls[0].child.listenerCount("exit"), 0);
});

for (const reason of ["abort", "timeout"]) {
	test(`${reason} targets only the owned PID/tree and settles once with clean timers/listeners`, async () => {
		const h = processHarness();
		const controller = new AbortController();
		const p = h.operations.exec("data", "cwd", { onData() {}, timeout: 2.5, signal: controller.signal });
		const rejection = assert.rejects(
			p,
			new RegExp(reason === "abort" ? "^Error: aborted$" : "^Error: timeout:2.5$"),
		);
		assert.equal([...h.timers.values()][0].ms, 2500);
		if (reason === "abort") controller.abort();
		else [...h.timers.values()][0].fn();
		assert.equal(h.calls.length, 2);
		assert.equal(h.calls[1].file, "C:\\Windows\\System32\\taskkill.exe");
		assert.deepEqual(h.calls[1].args, ["/PID", "101", "/T", "/F"]);
		assert.equal(h.calls[1].options.windowsHide, true);
		controller.abort();
		h.calls[0].child.emit("exit", null, null);
		h.calls[1].child.emit("exit", 0, null);
		await rejection;
		h.calls[0].child.emit("close", null, null);
		assert.equal(h.calls.length, 2);
		assert.equal(h.timers.size, 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		for (const { child } of h.calls) {
			assert.equal(child.listenerCount("exit"), 0);
			assert.equal(child.listenerCount("error"), 0);
		}
	});
}

test("tree termination failure and bounded terminator timeout are reported, not silent success", async () => {
	for (const mode of ["error", "nonzero", "stalled"]) {
		const h = processHarness();
		const controller = new AbortController();
		const p = h.operations.exec("data", "cwd", { onData() {}, signal: controller.signal });
		const rejection = assert.rejects(p, /could not terminate.*tree/);
		controller.abort();
		if (mode === "error") h.calls[1].child.emit("error", new Error("denied"));
		else if (mode === "nonzero") h.calls[1].child.emit("exit", 1);
		else [...h.timers.values()][0].fn();
		await rejection;
		assert.equal(h.calls[0].child.killed, true);
		assert.equal(h.timers.size, 0);
	}
});

test("exit drains output; late abort never targets a reused PID; inherited pipes are bounded", async () => {
	const h = processHarness();
	const controller = new AbortController();
	const chunks = [];
	const p = h.operations.exec("data", "cwd", { onData: (b) => chunks.push(b), signal: controller.signal });
	h.calls[0].child.emit("exit", 0, null);
	h.calls[0].child.stdout.emit("data", Buffer.from("last chunk"));
	controller.abort();
	await assert.rejects(p, /aborted/);
	assert.equal(h.calls.length, 1);
	assert.equal(Buffer.concat(chunks).toString(), "last chunk");
	const q = h.operations.exec("data", "cwd", { onData() {} });
	h.calls[1].child.emit("exit", null, "SIGTERM");
	[...h.timers.values()][0].fn();
	assert.deepEqual(await q, { exitCode: 143 });
	assert.equal(h.timers.size, 0);
});

for (const branch of ["nonzero", "error", "spawn-throw"]) {
	for (const mode of ["emit-error", "throw"]) {
		test(`termination fallback ${branch}/${mode} preserves failure and cleans up without escaping`, async () => {
			const h = processHarness({ taskkillThrows: branch === "spawn-throw" });
			const controller = new AbortController();
			let settlements = 0;
			const result = h.operations
				.exec("literal data", "public-cwd", { onData() {}, signal: controller.signal })
				.then(
					() => {
						settlements++;
						return "unexpected success";
					},
					(e) => {
						settlements++;
						return e.message;
					},
				);
			h.calls[0].child.kill = () => {
				if (mode === "throw") throw new Error("fallback kill failed");
				h.calls[0].child.emit("error", new Error("fallback kill failed"));
				return false;
			};
			controller.abort();
			const invoke = () => {
				if (branch === "nonzero") h.calls[1].child.emit("exit", 1, null);
				if (branch === "error") h.calls[1].child.emit("error", new Error("taskkill failed"));
			};
			assert.doesNotThrow(invoke, "fallback exceptions must not escape callbacks");
			await Promise.resolve();
			assert.equal(settlements, 1, "exec must already be settled");
			assert.equal(await result, "aborted; could not terminate the PowerShell process tree");
			h.calls[0].child.emit("close", null, null);
			h.calls[1].child.emit("close", null, null);
			controller.abort();
			assert.equal(settlements, 1);
			assert.equal(h.timers.size, 0);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			assert.deepEqual(
				h.calls.map((c) => c.file),
				[
					"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
					"C:\\Windows\\System32\\taskkill.exe",
				],
			);
			assert.deepEqual(h.calls[1].args, ["/PID", "101", "/T", "/F"]);
			for (const { child } of h.calls) {
				for (const event of ["error", "exit", "close"]) assert.equal(child.listenerCount(event), 0);
				assert.equal(child.stdout.listenerCount("data"), 0);
				assert.equal(child.stderr.listenerCount("data"), 0);
			}
		});
	}
}

for (const mode of ["emit-error", "throw"]) {
	test(`terminator kill ${mode} remains bounded and drains late errors until close`, async () => {
		const h = processHarness();
		const controller = new AbortController();
		let settlements = 0;
		const result = h.operations
			.exec("literal data", "public-cwd", { onData() {}, signal: controller.signal })
			.then(
				() => {
					settlements++;
					return "unexpected success";
				},
				(e) => {
					settlements++;
					return e.message;
				},
			);
		controller.abort();
		h.calls[1].child.kill = () => {
			if (mode === "throw") throw new Error("terminator kill failed");
			h.calls[1].child.emit("error", new Error("terminator kill failed"));
			return false;
		};
		assert.doesNotThrow(() => [...h.timers.values()][0].fn());
		await Promise.resolve();
		assert.equal(settlements, 1);
		assert.equal(await result, "aborted; could not terminate the PowerShell process tree");
		assert.doesNotThrow(() => h.calls[1].child.emit("error", new Error("late terminator error")));
		for (const { child } of h.calls) child.emit("close", null, null);
		assert.equal(h.timers.size, 0);
		assert.equal(settlements, 1);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		assert.deepEqual(h.calls[1].args, ["/PID", "101", "/T", "/F"]);
		assert.equal(h.calls.length, 2, "only the owned shell and its terminator were spawned");
		for (const { child } of h.calls)
			for (const event of ["error", "exit", "close"]) assert.equal(child.listenerCount(event), 0);
	});
}

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthHelper } from "../src/auth-helper.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

class Child extends EventEmitter {
	connected = true;
	exitCode: number | null = null;
	signalCode: string | null = null;
	stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
	send = vi.fn();
	kill = vi.fn(() => true);
	result(id: number, result: unknown) {
		this.emit("message", { kind: "result", id, result });
	}
	exit() {
		this.exitCode = 1;
		this.connected = false;
		this.emit("exit", 1, null);
	}
}

function setup() {
	const children: Record<number, Child> = {};
	let count = 0;
	spawn.mockImplementation(() => {
		const child = new Child();
		children[count++] = child;
		return child;
	});
	const log = vi.fn();
	const options = {
		command: "synthetic-helper",
		args: ["--synthetic"],
		user: { uid: 123, gid: 456 },
		env: { SYNTHETIC: "yes" },
		agentHome: "/synthetic/home",
		cwd: "/synthetic/cwd",
		log,
	};
	const child = (index: number): Child => {
		const owned = children[index];
		if (!owned) throw new Error(`Missing synthetic child ${index}`);
		return owned;
	};
	return { helper: new AuthHelper(options), child, log, options };
}

async function runtime(s: ReturnType<typeof setup>) {
	const pending = s.helper.runtime();
	s.child(0).result(1, {
		providers: [{ id: "test", name: "Test", auth: { apiKey: { name: "Key" } } }],
		status: { test: { configured: true, source: "stored" } },
	});
	return pending;
}

afterEach(() => vi.clearAllMocks());

describe("owned sign-in helper lifecycle (synthetic child only)", () => {
	it("retains concurrent close completion until owned child close, rejecting pending calls promptly", async () => {
		const s = setup();
		const pending = s.helper.runtime().catch((error: Error) => error.message);
		const child = s.child(0);
		const close = s.helper.close();
		expect(close).toBeInstanceOf(Promise);
		expect(s.helper.close()).toBe(close);
		let completed = false;
		Promise.resolve(close).then(() => {
			completed = true;
		});
		expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
		expect(await pending).toBe("The sign-in helper stopped.");
		child.exit();
		await Promise.resolve();
		expect(completed).toBe(false);
		child.emit("close", 1, null);
		await close;
		expect(completed).toBe(true);
		expect(child.kill).toHaveBeenCalledTimes(1);
	});

	it("never starts after close, including never-started and retained runtimes", async () => {
		const empty = setup();
		await empty.helper.close();
		const afterClose = empty.helper.runtime();
		// Answer an incorrectly spawned child so the RED fails immediately, not on a timeout.
		if (spawn.mock.calls.length) empty.child(0).result(1, {});
		await expect(afterClose).rejects.toThrow("The sign-in helper stopped.");
		expect(spawn).not.toHaveBeenCalled();
		const s = setup();
		const api = await runtime(s);
		const closing = s.helper.close();
		await expect(api.logout("test")).rejects.toThrow("The sign-in helper stopped.");
		await expect(s.helper.runtime()).rejects.toThrow("The sign-in helper stopped.");
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(s.child(0).send).toHaveBeenCalledTimes(1);
		s.child(0).emit("close", null, "SIGTERM");
		await closing;
	});

	it("preserves snapshot filtering, exact spawn identity and RPC errors before close", async () => {
		const s = setup();
		const api = await runtime(s);
		const child = s.child(0);
		expect(spawn).toHaveBeenCalledExactlyOnceWith(s.options.command, s.options.args, {
			cwd: s.options.cwd,
			env: {
				SYNTHETIC: "yes",
				GENTLE_DOT_AUTH_HOME: s.options.agentHome,
				GENTLE_DOT_AUTH_CWD: s.options.cwd,
			},
			uid: 123,
			gid: 456,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			serialization: "json",
		});
		expect(child.send).toHaveBeenCalledExactlyOnceWith({ kind: "call", id: 1, method: "snapshot" });
		expect(api.getProviders()).toEqual([{ id: "test", name: "Test", auth: { apiKey: { name: "Key" } } }]);
		expect(api.getProviderAuthStatus("test")).toEqual({ configured: true, source: "stored" });
		expect(api.getProviderAuthStatus("unknown")).toEqual({ configured: false });
		const logout = api.logout("test");
		expect(child.send).toHaveBeenLastCalledWith({
			kind: "call",
			id: 2,
			method: "logout",
			params: { providerId: "test" },
		});
		child.emit("message", { kind: "result", id: 2, error: "synthetic refusal" });
		await expect(logout).rejects.toThrow("synthetic refusal");
		child.stderr.emit("data", `\n${"x".repeat(350)}\n`);
		expect(s.log).toHaveBeenCalledExactlyOnceWith(`[sign-in helper] ${"x".repeat(300)}`);
		const key = api.openAIApiKey?.();
		child.emit("message", null);
		child.emit("message", { kind: "result", id: 999, result: "ignored" });
		child.result(3, { key: "synthetic-key" });
		expect(await key).toBe("synthetic-key");
		const close = s.helper.close();
		child.emit("close", 0, null);
		await close;
	});

	it("restarts after unexpected exit but waits for every owned child's close", async () => {
		const s = setup();
		const first = s.helper.runtime();
		const rejected = expect(first).rejects.toThrow("The sign-in helper stopped.");
		s.child(0).exit();
		await rejected;
		expect(s.log).toHaveBeenCalledExactlyOnceWith("the sign-in helper stopped (code 1)");
		const second = s.helper.runtime();
		s.child(1).result(2, {});
		await second;
		const close = s.helper.close();
		let completed = false;
		Promise.resolve(close).then(() => {
			completed = true;
		});
		expect(s.child(0).kill).not.toHaveBeenCalled();
		expect(s.child(1).kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
		s.child(1).emit("close", 0, null);
		await Promise.resolve();
		expect(completed).toBe(false);
		s.child(0).emit("close", 1, null);
		await close;
	});

	it("retains signal failures and never treats a refused signal as completion", async () => {
		const s = setup();
		await runtime(s);
		const error = new Error("synthetic kill failure");
		s.child(0).kill.mockImplementation(() => {
			throw error;
		});
		const closing = s.helper.close();
		await expect(closing).rejects.toBe(error);
		expect(s.helper.close()).toBe(closing);
		await expect(s.helper.runtime()).rejects.toThrow("The sign-in helper stopped.");
		s.child(0).emit("close", 0, null);
		await expect(closing).rejects.toBe(error);
		expect(s.child(0).kill).toHaveBeenCalledTimes(1);

		const refused = setup();
		await runtime(refused);
		refused.child(0).kill.mockReturnValue(false);
		const close = refused.helper.close();
		let completed = false;
		close.then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		refused.child(0).emit("close", 0, null);
		await close;
	});

	it("rejects spawn errors, preserves restart diagnostics and handles already closed children", async () => {
		const s = setup();
		const pending = s.helper.runtime();
		const rejected = expect(pending).rejects.toThrow("The sign-in helper stopped.");
		s.child(0).emit("error", new Error("synthetic spawn refusal"));
		s.child(0).emit("close", -1, null);
		await rejected;
		expect(s.log).toHaveBeenCalledExactlyOnceWith("the sign-in helper stopped (synthetic spawn refusal)");
		const next = s.helper.runtime();
		s.child(1).result(2, { providers: [{ id: 42 }, { id: "valid", name: "Valid" }], status: {} });
		expect((await next).getProviders()).toEqual([{ id: "valid", name: "Valid", auth: {} }]);
		s.child(1).exit();
		s.child(1).emit("close", 1, null);
		await s.helper.close();
		expect(s.child(0).kill).not.toHaveBeenCalled();
		expect(s.child(1).kill).not.toHaveBeenCalled();
	});

	it.each([false, true])("retains emitted signal errors after close (older child: %s)", async (older) => {
		const s = setup();
		await runtime(s);
		const child = s.child(0);
		if (older) {
			child.emit("error", new Error("synthetic earlier failure"));
			const next = s.helper.runtime();
			s.child(1).result(2, {});
			await next;
		}
		const error = Object.assign(new Error("synthetic emitted signal failure"), { code: "EPERM" });
		child.kill.mockImplementation(() => {
			child.emit("error", error);
			return false;
		});
		const closing = s.helper.close();
		const outcome = closing.then(
			() => ({ status: "resolved" }),
			(error: unknown) => ({ status: "rejected", error }),
		);
		child.emit("close", 0, null);
		if (older) s.child(1).emit("close", 0, null);
		expect(await outcome).toEqual({ status: "rejected", error });
		await expect(closing).rejects.toBe(error);
		expect(s.helper.close()).toBe(closing);
		await expect(s.helper.runtime()).rejects.toThrow("The sign-in helper stopped.");
		expect(spawn).toHaveBeenCalledTimes(older ? 2 : 1);
		expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
		expect(child.send).toHaveBeenCalledTimes(1);
		if (older) {
			expect(s.child(1).kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
			expect(s.child(1).send).toHaveBeenCalledTimes(1);
		}
	});

	it("fences late prompt answers and abort callbacks without respawning", async () => {
		const s = setup();
		const api = await runtime(s);
		let answer!: (value: string) => void;
		const prompt = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					answer = resolve;
				}),
		);
		const notify = vi.fn();
		const controller = new AbortController();
		const login = api.login("test", "api_key", { prompt, notify, signal: controller.signal });
		const rejected = expect(login).rejects.toThrow("The sign-in helper stopped.");
		const child = s.child(0);
		child.emit("message", { kind: "notify", id: 2, event: { type: "info", message: "hello" } });
		child.emit("message", { kind: "prompt", id: 2, promptId: 7, request: { type: "input", message: "Key" } });
		expect(notify).toHaveBeenCalledExactlyOnceWith({ type: "info", message: "hello" });
		expect(prompt).toHaveBeenCalledExactlyOnceWith({
			type: "input",
			message: "Key",
			signal: controller.signal,
		});
		const close = s.helper.close();
		child.emit("close", 0, null);
		await close;
		answer("synthetic-answer");
		controller.abort();
		await rejected;
		await Promise.resolve();
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(child.send).toHaveBeenCalledTimes(2);
	});
});

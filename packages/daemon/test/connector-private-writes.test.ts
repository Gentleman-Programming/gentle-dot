import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { childGuardText } from "../src/child-guard.ts";
import { ConnectorStore, renderMcpJson } from "../src/connectors.ts";
import { engineAccess, insideEngineAccess } from "../src/engine-access.ts";
import { tempDir } from "./helpers.ts";
import { expectPrivateFilePermissions } from "./private-file-permissions.ts";

it("keeps MCP and child-guard writes private without changing their bytes or Unix engine brackets", () => {
	const root = tempDir();
	const guardPath = join(root, "approval-guard.ts");
	const store = new ConnectorStore({
		dataDir: root,
		agentHome: join(root, "agent"),
		guardPath,
		childGuard: true,
	});
	const endpoint = { url: "http://127.0.0.1:51234/mcp", token: "synthetic-private-write-key" };
	let updated = 0;
	let reverted = 0;
	store.onUpdated = () => updated++;
	store.onReverted = () => reverted++;
	expect(store.setComputer(endpoint)).toBe(true);
	expect(store.enforce(false)).toBe(true);
	const guard = store.childGuard;
	expect(guard).toBeDefined();
	if (!guard) throw new Error("Missing child guard");
	const mcp = renderMcpJson({ connectors: {} }, endpoint);
	const text = childGuardText(guardPath);
	for (const [file, expected] of [[store.mcpFile, mcp], [guard.file, text]]) {
		expect(readFileSync(file!, "utf8")).toBe(expected);
		expectPrivateFilePermissions(file!);
	}
	expect(store.childGuardReady()).toBe(true);
	expect(store.setComputer(endpoint)).toBe(false);
	expect(store.enforce()).toBe(false);
	expect(store.state()).toEqual({ connectors: {} });
	expect([updated, reverted]).toEqual([0, 0]);

	// Exercise the unchanged Unix route under a real bracket depth, without claiming Linux euid proof.
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	const euid = Object.getOwnPropertyDescriptor(process, "geteuid");
	let brackets = 0;
	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
		Object.defineProperty(process, "geteuid", { configurable: true, value: () => 1001 });
		const access = engineAccess({ uid: 1001, gid: 1001 });
		const unix = new ConnectorStore({
			dataDir: join(root, "unused-data"),
			agentHome: join(root, "unix-agent"),
			guardPath,
			childGuard: true,
			engineAccess: (fn) => access(() => {
				expect(insideEngineAccess()).toBe(true);
				brackets++;
				return fn();
			}),
		});
		expect(unix.setComputer(endpoint)).toBe(true);
		expect(unix.enforce(false)).toBe(true);
		expect(readFileSync(unix.mcpFile, "utf8")).toBe(mcp);
		expect(readFileSync(unix.childGuard!.file, "utf8")).toBe(text);
		writeFileSync(unix.childGuard!.file, "changed");
		expect(unix.enforce(false)).toBe(true);
		expect(unix.childGuardReady()).toBe(true);
		expect(brackets).toBeGreaterThan(0);
		expect(insideEngineAccess()).toBe(false);
	} finally {
		Object.defineProperty(process, "platform", platform);
		if (euid) Object.defineProperty(process, "geteuid", euid);
		else Reflect.deleteProperty(process, "geteuid");
	}
});

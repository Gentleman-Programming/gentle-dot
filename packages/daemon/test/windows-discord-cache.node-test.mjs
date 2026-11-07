import assert from "node:assert/strict";
import { win32 as path } from "node:path";
import test from "node:test";
import { discordStdioLaunch } from "../src/windows-discord-launch.ts";

// In-memory filesystem only: no profiles, runtimes, package execution or environment overrides.
const local = "C:\\Users\\Example User\\AppData\\Local";
const root = path.join(local, "npm-cache", "_npx"),
	hash = "0123456789abcdef";
const args = ["-y", "@pasympa/discord-mcp@2.2.0"];
const refusal = "Discord cached server is unavailable or ambiguous. No download or retry was attempted.";
function tree() {
	const nodes = new Map();
	let names = [hash];
	let reads = 0;
	function dir(p) {
		for (;;) {
			nodes.set(p, { kind: "dir" });
			const up = path.dirname(p);
			if (up === p) break;
			p = up;
		}
	}
	function add(
		id = hash,
		metadata = { name: "@pasympa/discord-mcp", version: "2.2.0", bin: { "discord-mcp": "dist/index.js" } },
	) {
		const pkg = path.join(root, id, "node_modules", "@pasympa", "discord-mcp");
		const manifest = path.join(pkg, "package.json"),
			entry = path.join(pkg, "dist", "index.js");
		dir(path.dirname(entry));
		nodes.set(manifest, { kind: "file", text: JSON.stringify(metadata) });
		nodes.set(entry, { kind: "file" });
		return { manifest, entry, pkg };
	}
	const selected = add();
	const io = {
		stat(p) {
			const n = nodes.get(p);
			if (!n) throw Object.assign(Error("private sentinel"), { code: "ENOENT" });
			return {
				isDirectory: () => n.kind === "dir",
				isFile: () => n.kind === "file",
				isSymbolicLink: () => !!n.link,
				nlink: n.links ?? 1,
				size: n.size ?? Buffer.byteLength(n.text ?? ""),
			};
		},
		entries(p) {
			assert.equal(p, root);
			return [...names];
		},
		read(p) {
			reads++;
			return nodes.get(p).text;
		},
	};
	return {
		nodes,
		selected,
		io,
		add,
		names: (v) => {
			names = v;
		},
		reads: () => reads,
	};
}
function launch(t, appData = local) {
	return discordStdioLaunch("discord", "npx", args, "win32", "C:\\Program Files", appData, t.io);
}
function refused(t, appData = local) {
	assert.throws(
		() => launch(t, appData),
		(e) => e.message === refusal,
	);
}

test("S46 exact pinned desktop launch directly uses existing absolute Node and validated JS, preserving inputs", () => {
	const t = tree(),
		before = [...args];
	assert.deepEqual(launch(t), { command: "C:\\Program Files\\nodejs\\node.exe", args: [t.selected.entry] });
	assert.deepEqual(args, before);
	assert.equal(t.reads(), 1);
});
test("S46 missing or relative local cache root refuses without reading files or downloading", () => {
	for (const appData of [undefined, "", "relative", "C:relative", "\\\\host\\share"]) {
		const t = tree();
		assert.throws(
			() => discordStdioLaunch("discord", "npx", args, "win32", undefined, appData, t.io),
			(e) => e.message === refusal,
		);
		assert.equal(t.reads(), 0);
	}
});
test("S46 validates package name, exact version and bin path and never echoes malformed metadata", () => {
	for (const metadata of [
		null,
		{ name: "other" },
		{ name: "@pasympa/discord-mcp", version: "1.0.0" },
		{ name: "@pasympa/discord-mcp", version: "2.2.0", bin: { "discord-mcp": "../../outside.js" } },
		{ name: "@pasympa/discord-mcp", version: "2.2.0", bin: { other: "dist/index.js" } },
	]) {
		const t = tree();
		t.nodes.get(t.selected.manifest).text = JSON.stringify(metadata);
		refused(t);
	}
	const t = tree();
	t.nodes.get(t.selected.manifest).text = "private sentinel";
	refused(t);
});
test("S46 refuses symlink or hard-linked entry/manifest and linked directory ancestors", () => {
	for (const target of ["entry", "manifest", "pkg"]) {
		const t = tree();
		t.nodes.get(t.selected[target]).link = true;
		refused(t);
	}
	for (const target of ["entry", "manifest"]) {
		const t = tree();
		t.nodes.get(t.selected[target]).links = 2;
		refused(t);
	}
	const t = tree();
	t.nodes.get(local).link = true;
	refused(t);
});
test("S46 missing, ambiguous, oversized or excessive cache contents refuse without a fallback process", () => {
	for (const target of ["entry", "manifest"]) {
		const t = tree();
		t.nodes.delete(t.selected[target]);
		refused(t);
	}
	const a = tree();
	a.add("fedcba9876543210");
	a.names([hash, "fedcba9876543210"]);
	refused(a);
	const b = tree();
	b.nodes.get(b.selected.manifest).size = 32769;
	refused(b);
	assert.equal(b.reads(), 0);
	const c = tree();
	c.names(Array(65).fill(hash));
	refused(c);
	assert.equal(c.reads(), 0);
	const d = tree();
	d.names([]);
	refused(d);
});
test("S46 existing sibling/platform/custom-command and extra-argument behavior never reads the cache", () => {
	const io = {
		stat() {
			assert.fail("unexpected cache read");
		},
		entries() {
			assert.fail("unexpected cache listing");
		},
		read() {
			assert.fail("unexpected metadata read");
		},
	};
	for (const [id, command, platform, tail] of [
		["gmail", "npx", "win32", args],
		["discord", "npx", "linux", args],
		["discord", "npx.cmd", "win32", args],
		["discord", "npx", "win32", [...args, "--custom"]],
		["discord", "npx", "win32", ["-y", "other"]],
	]) {
		const result = discordStdioLaunch(id, command, tail, platform, undefined, local, io);
		const previous = discordStdioLaunch(id, command, tail, platform);
		assert.deepEqual(result, previous);
	}
});

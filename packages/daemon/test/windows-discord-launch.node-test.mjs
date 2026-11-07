import assert from "node:assert/strict";
import test from "node:test";

const moduleURL = new URL("../src/windows-discord-launch.ts", import.meta.url);
test("S43 Windows Discord uses absolute existing Node/npm entry and preserves every original argument", async () => {
	const { discordStdioLaunch } = await import(moduleURL);
	const args = ["-y", "@pasympa/discord-mcp@2.2.0", "value with spaces", "& untouched"];
	const before = [...args],
		result = discordStdioLaunch("discord", "npx", args, "win32", "C:\\Program Files");
	assert.deepEqual(result, {
		command: "C:\\Program Files\\nodejs\\node.exe",
		args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js", ...args],
	});
	assert.deepEqual(args, before);
});
test("S43 installation root is absolute, defaults to observed standard location, never changes caller metadata", async () => {
	const { discordStdioLaunch } = await import(moduleURL);
	assert.equal(
		discordStdioLaunch("discord", "npx", [], "win32").command,
		"C:\\Program Files\\nodejs\\node.exe",
	);
	assert.equal(
		discordStdioLaunch("discord", "npx", [], "win32", "D:\\Program Files").command,
		"D:\\Program Files\\nodejs\\node.exe",
	);
	assert.equal(
		discordStdioLaunch("discord", "npx", [], "win32", "relative").command,
		"C:\\Program Files\\nodejs\\node.exe",
	);
});
test("S43 sibling connectors, nonWindows and custom command contracts remain exact", async () => {
	const { discordStdioLaunch } = await import(moduleURL);
	for (const [id, command, platform] of [
		["memory", "npx", "win32"],
		["discord", "npx", "linux"],
		["discord", "npx", "darwin"],
		["discord", "npx.cmd", "win32"],
		["discord", "C:\\custom\\npx.cmd", "win32"],
		["discord", "node", "win32"],
	]) {
		const args = ["--existing", "two words"];
		assert.deepEqual(discordStdioLaunch(id, command, args, platform), { command, args });
		assert.deepEqual(args, ["--existing", "two words"]);
	}
});

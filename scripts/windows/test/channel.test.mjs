import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const channelModule = new URL("../../../packages/daemon/src/app-channel.ts", import.meta.url).href;

function isolatedEnv(root) {
	const env = {};
	for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	for (const key of [
		"HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR",
		"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
		"npm_config_cache", "GOCACHE", "GOMODCACHE",
	]) {
		env[key] = join(root, key);
		mkdirSync(env[key], { recursive: true });
	}
	return { ...env, GOTOOLCHAIN: "local", GOENV: "off", GOPROXY: "off", GOSUMDB: "off" };
}

test("owned Windows stdio exchanges protocol frames and closes without leaking its selector", {
	skip: process.platform !== "win32" ? "Windows anonymous-pipe integration" : false,
	timeout: 20_000,
}, async (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "gentle-dot-channel-"));
	t.diagnostic(`retained channel fixture: ${fixture}`);
	const env = isolatedEnv(join(fixture, "channel-env"));
	const probeEnv = isolatedEnv(join(fixture, "probe-env"));
	const script = `
        import { inheritedAppSocket, AppChannel } from ${JSON.stringify(channelModule)};
        import { spawnSync } from 'node:child_process';
        const channel = new AppChannel(inheritedAppSocket());
        const sentinel = process.env.GENTLE_DOT_CHANNEL_TEST_SENTINEL ?? null;
        channel.handler = () => {
            process.env.GENTLE_DOT_CHANNEL_TEST_SENTINEL = 'synthetic-nested-nonsecret';
            const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
                'import { inheritedAppSocket } from '+${JSON.stringify(JSON.stringify(channelModule))}+';process.stdout.write(JSON.stringify({channel:!!inheritedAppSocket(),selector:process.env.GENTLE_DOT_APP_STDIO??null,sentinel:process.env.GENTLE_DOT_CHANNEL_TEST_SENTINEL??null}))'],
                {env:${JSON.stringify(probeEnv)},encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:5000});
            if(child.status!==0) throw new Error('child probe failed');
            return {selector:process.env.GENTLE_DOT_APP_STDIO??null,sentinel,child:JSON.parse(child.stdout)};
        };
        channel.onClose(()=>process.exit(0));
    `;
	writeFileSync(join(fixture, "channel.mjs"), script);
	const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
		env: { ...env, GENTLE_DOT_APP_STDIO: "v1" },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	let errors = "";
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		errors += chunk;
	});
	const lines = createInterface({ input: child.stdout });
	try {
		const reply = Promise.race([
			once(lines, "line"),
			once(child, "exit").then(([code]) => {
				throw new Error(`channel child exited ${code}: ${errors}`);
			}),
		]);
		const request = `${JSON.stringify({ kind: "request", id: 1, method: "probe" })}\n`;
		writeFileSync(join(fixture, "request.jsonl"), request);
		child.stdin.write(request);
		const [line] = await reply;
		assert.deepEqual(JSON.parse(line), {
			kind: "response",
			id: 1,
			result: { selector: null, sentinel: null, child: { channel: false, selector: null, sentinel: null } },
		});
		const exited = once(child, "exit");
		child.stdin.end();
		const [code] = await exited;
		assert.equal(code, 0, errors);
	} finally {
		lines.close();
		if (child.exitCode === null) child.kill();
		writeFileSync(join(fixture, "stdout.jsonl"), output);
		writeFileSync(join(fixture, "stderr.txt"), errors);
		writeFileSync(join(fixture, "result.json"), JSON.stringify({
			exitCode: child.exitCode, signalCode: child.signalCode, retained: true,
		}, null, 2));
	}
});

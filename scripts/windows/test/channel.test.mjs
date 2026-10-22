import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

const channelModule = new URL("../../../packages/daemon/src/app-channel.ts", import.meta.url).href;

test("owned Windows stdio exchanges protocol frames and closes without leaking its selector", {
	skip: process.platform !== "win32" ? "Windows anonymous-pipe integration" : false,
	timeout: 20_000,
}, async () => {
	const script = `
        import { inheritedAppSocket, AppChannel } from ${JSON.stringify(channelModule)};
        import { spawnSync } from 'node:child_process';
        const channel = new AppChannel(inheritedAppSocket());
        channel.handler = () => {
            const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
                'import { inheritedAppSocket } from '+${JSON.stringify(JSON.stringify(channelModule))}+';process.stdout.write(JSON.stringify({channel:!!inheritedAppSocket(),selector:process.env.GENTLE_DOT_APP_STDIO??null}))'],
                {encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,timeout:5000});
            if(child.status!==0) throw new Error('child probe failed');
            return {selector:process.env.GENTLE_DOT_APP_STDIO??null,child:JSON.parse(child.stdout)};
        };
        channel.onClose(()=>process.exit(0));
    `;
	const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
		env: { ...process.env, GENTLE_DOT_APP_STDIO: "v1" },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
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
		child.stdin.write(`${JSON.stringify({ kind: "request", id: 1, method: "probe" })}\n`);
		const [line] = await reply;
		assert.deepEqual(JSON.parse(line), {
			kind: "response",
			id: 1,
			result: { selector: null, child: { channel: false, selector: null } },
		});
		const exited = once(child, "exit");
		child.stdin.end();
		const [code] = await exited;
		assert.equal(code, 0, errors);
	} finally {
		lines.close();
		if (child.exitCode === null) child.kill();
	}
});

#!/usr/bin/env node
// A daemon stand-in that received the desktop app's end of the channel on fd 3 (like the real
// daemon, spawned by the app). It opens the channel the way cli.ts does, spawns children the way
// the daemon spawns the engine and stdio servers, and reports over the channel what each child saw
// on fd 3. Argument "leak": open with a probe that passes fd 3 on, as a platform that leaks would.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { childInherits, openInheritedChannel } from "../../src/app-channel.ts";

/** What a child sees on fd 3: the socket's identity, or "none". */
const PRINT_FD3 =
	"try{const s=require('fs').fstatSync(3,{bigint:true});console.log(s.isSocket()?s.dev+':'+s.ino:'other')}catch{console.log('none')}";

const own = fstatSync(3, { bigint: true });
const identity = `${own.dev}:${own.ino}`;
const leak = process.argv[2] === "leak";
const channel = openInheritedChannel({
	log: (line) => process.stderr.write(`${line}\n`),
	...(leak
		? { probe: (fd: number, id: string) => childInherits(fd, id, ["ignore", "pipe", "ignore", fd]) }
		: {}),
});
if (!channel) {
	// Refused: fd 3 must be closed too, so nothing below could pass it on.
	let closed = false;
	try {
		fstatSync(3);
	} catch {
		closed = true;
	}
	process.stdout.write(`${JSON.stringify({ refused: true, closed })}\n`);
	process.exit(0);
}

const fromSpawn = await new Promise<string>((resolve) => {
	// Like the supervisor starts the engine: pipes for stdio and nothing else.
	const child = spawn(process.execPath, ["-e", PRINT_FD3], { stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.on("close", () => resolve(out.trim()));
});
const fromSpawnSync = spawnSync(process.execPath, ["-e", PRINT_FD3], { encoding: "utf8" }).stdout.trim();
const fromShell = execFileSync("/bin/sh", ["-c", "if [ -e /dev/fd/3 ]; then echo open; else echo none; fi"], {
	encoding: "utf8",
}).trim();
channel.handler = async (method, params) => (method === "echo" ? params : undefined);
await channel.request(
	"report",
	{
		identity,
		fromSpawn,
		fromSpawnSync,
		fromShell,
		detectsALeak: childInherits(3, identity, ["ignore", "pipe", "ignore", 3]),
	},
	5000,
);
channel.close();

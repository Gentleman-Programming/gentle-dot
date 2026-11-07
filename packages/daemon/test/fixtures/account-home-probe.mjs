// Metadata only: never invoke the SDK, admission, or an unisolated native account lookup.

import { createRequire } from "node:module";
import os, { homedir, userInfo } from "node:os";
import { join } from "node:path";

const cjs = createRequire(import.meta.url)("node:os");
if (!userInfo[Symbol.for("gentle-dot.test-account-home")]) {
	console.log("account-home isolation missing");
	process.exit(78);
}
const root = process.env.GENTLE_DOT_TEST_ACCOUNT_HOME;
const current = () => join(root, `uid-${process.geteuid?.() ?? "windows"}`);
const matches = () =>
	[userInfo(), os.userInfo(), cjs.userInfo()].every(
		(info) => info.homedir === current() && info.username === "fixture-account",
	);
const initial = matches();
const homes = [homedir(), os.homedir(), cjs.homedir()].every((home) => home === process.env.HOME);
// Model effective-user changes without calling seteuid or touching real account profiles.
const original = process.geteuid;
let routed = true;
if (original) {
	process.geteuid = () => 424242;
	routed = matches() && userInfo().uid === 424242;
	process.geteuid = original;
}
const buffer = userInfo({ encoding: "buffer" });
const encoded = Buffer.isBuffer(buffer.homedir) && buffer.homedir.toString() === current();
if (!initial || !homes || !routed || !encoded) {
	console.error("fixture metadata mismatch");
	process.exit(1);
}
console.log("fixture metadata isolated: named/default/cjs; effective-user routing; buffer encoding");

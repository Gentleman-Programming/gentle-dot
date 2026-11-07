// Test entrypoints only. Node preloads this before native ESM/CJS consumers, not in production.

import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { isAbsolute, join } from "node:path";

const root = process.env.GENTLE_DOT_TEST_ACCOUNT_HOME;
if (!root || !isAbsolute(root)) throw new Error("An absolute fixture account root is required.");
const uid = () => process.geteuid?.() ?? -1;
const accountHome = () => join(root, `uid-${process.geteuid?.() ?? "windows"}`);
function fixtureUserInfo(options) {
	const encode = (value) => (options?.encoding === "buffer" ? Buffer.from(value) : value);
	return {
		uid: uid(),
		gid: process.getegid?.() ?? -1,
		username: encode("fixture-account"),
		homedir: encode(accountHome()),
		shell: process.platform === "win32" ? null : encode("/bin/sh"),
	};
}
fixtureUserInfo[Symbol.for("gentle-dot.test-account-home")] = true;
os.userInfo = fixtureUserInfo;
// A seeded HOME stays distinct from account metadata, just like native userInfo vs homedir.
os.homedir = () => process.env.HOME ?? accountHome();
syncBuiltinESMExports();

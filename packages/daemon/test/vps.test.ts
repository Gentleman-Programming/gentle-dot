// Server mode (S25.8): explicit, only when GENTLE_DOT_VPS is on; the daemon runs as root in its
// container, the engine as another user, and stdio connector servers as a third one.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NO_SECRETS_KEY } from "../src/secret-file.ts";
import { handOverCommand, loadVpsOptions, lookupUser, stdioCommand, vpsEnabled } from "../src/vps.ts";

const PASSWD = [
	"root:x:0:0:root:/root:/bin/bash",
	"dot:x:1000:1000::/home/dot:/bin/sh",
	"dotmcp:x:1001:1001::/nonexistent:/usr/sbin/nologin",
	"",
].join("\n");

const base = { GENTLE_DOT_VPS: "1", GENTLE_DOT_ENGINE_USER: "dot", GENTLE_DOT_CONNECTOR_USER: "dotmcp" };

describe("server mode", () => {
	it("is on only when GENTLE_DOT_VPS says so", () => {
		expect(vpsEnabled({})).toBe(false);
		expect(vpsEnabled({ GENTLE_DOT_VPS: "0" })).toBe(false);
		expect(vpsEnabled({ GENTLE_DOT_VPS: "" })).toBe(false);
		for (const value of ["1", "on", "true", "TRUE"]) expect(vpsEnabled({ GENTLE_DOT_VPS: value })).toBe(true);
		expect(loadVpsOptions({ GENTLE_DOT_ENGINE_USER: "dot" }, { uid: 0, passwd: PASSWD })).toBeUndefined();
	});

	it("finds the users by name or as uid:gid", () => {
		expect(lookupUser("dot", PASSWD)).toEqual({ uid: 1000, gid: 1000 });
		expect(lookupUser("1234:5678", PASSWD)).toEqual({ uid: 1234, gid: 5678 });
		expect(() => lookupUser("nobody-here", PASSWD)).toThrow(/nobody-here/);
	});

	it("resolves the engine and connector users and the secrets key", () => {
		const key = randomBytes(32);
		const options = loadVpsOptions(
			{ ...base, GENTLE_DOT_SECRETS_KEY: key.toString("base64") },
			{ uid: 0, passwd: PASSWD },
		);
		expect(options).toMatchObject({ engine: { uid: 1000, gid: 1000 }, connector: { uid: 1001, gid: 1001 } });
		expect(options?.secretsKey).toEqual(key);
		// Without a key the server starts, and connectors that need a secret fail closed with why.
		const none = loadVpsOptions(base, { uid: 0, passwd: PASSWD });
		expect(none?.secretsKey).toBeUndefined();
		expect(none?.secretsKeyProblem).toBe(NO_SECRETS_KEY);
		const bad = loadVpsOptions({ ...base, GENTLE_DOT_SECRETS_KEY: "short" }, { uid: 0, passwd: PASSWD });
		expect(bad?.secretsKeyProblem).toMatch(/32 bytes/);
	});

	it("refuses to start half-separated", () => {
		// Only root can start the engine as another user.
		expect(() => loadVpsOptions(base, { uid: 1000, passwd: PASSWD })).toThrow(/root/);
		expect(() =>
			loadVpsOptions({ ...base, GENTLE_DOT_ENGINE_USER: "root" }, { uid: 0, passwd: PASSWD }),
		).toThrow(/must not be root/);
		expect(() =>
			loadVpsOptions({ ...base, GENTLE_DOT_CONNECTOR_USER: "dot" }, { uid: 0, passwd: PASSWD }),
		).toThrow(/different/);
		expect(() =>
			loadVpsOptions({ ...base, GENTLE_DOT_ENGINE_USER: "ghost" }, { uid: 0, passwd: PASSWD }),
		).toThrow(/ghost/);
	});

	it("hands the daemon's files in the engine's folders over with chown, never following links", () => {
		expect(handOverCommand({ uid: 1000, gid: 1000 }, { uid: 0, gid: 0 }, ["/d/agent", "/d/home"])).toEqual({
			command: "chown",
			args: ["-R", "-P", "--from=0:0", "1000:1000", "--", "/d/agent", "/d/home"],
		});
	});

	it("runs a stdio connector server as the connector user, with no supplementary groups", () => {
		expect(stdioCommand({ uid: 1001, gid: 1001 }, "npx", ["-y", "server"])).toEqual({
			command: "setpriv",
			args: [
				"--reuid=1001",
				"--regid=1001",
				"--clear-groups",
				"--inh-caps=-all",
				"--",
				"npx",
				"-y",
				"server",
			],
		});
		// Without server mode, the server runs as it does today.
		expect(stdioCommand(undefined, "npx", ["-y", "server"])).toEqual({
			command: "npx",
			args: ["-y", "server"],
		});
	});
});

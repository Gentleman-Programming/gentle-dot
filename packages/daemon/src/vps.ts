/**
 * Server mode (S25.8, docs/deploy-vps.md): the container's daemon, explicitly turned on with
 * `GENTLE_DOT_VPS=1`; a desktop build never turns it on by itself. The daemon runs as root inside
 * its container (with only the capabilities compose.yaml grants) so it can start the engine as
 * another user (`GENTLE_DOT_ENGINE_USER`, default `dot`) and the stdio connector servers it runs as
 * a third one (`GENTLE_DOT_CONNECTOR_USER`, default `dotmcp`). The data folder is the daemon's
 * (0711: the engine passes through it to its own folders but cannot list it); the access key,
 * `connectors.json`, the encrypted secrets, and the PIN hash stay the daemon's (0600), and the
 * engine's folders ({@link ENGINE_DIRS}) belong to the engine's user. The daemon reaches them only
 * as the engine's user (`engine-access.ts`), and signs in through a helper running as that user
 * (`auth-helper.ts`), so what it makes there is the engine's. Files an older version left there as
 * root are handed over once at start with `chown -R -P --from=<daemon> <engine>`: GNU chown walks
 * with directory descriptors and never follows a link, and `--from` touches only the daemon's files.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthHelperCommand } from "./auth-helper.ts";
import type { EngineAccess } from "./engine-access.ts";
import { BAD_SECRETS_KEY, NO_SECRETS_KEY, parseSecretsKey, SECRETS_KEY_VAR } from "./secret-file.ts";

export interface OsUser {
	uid: number;
	gid: number;
}

export interface VpsOptions {
	/** The engine's user: the engine, its tools and shell, and its subagents run as it. */
	engine: OsUser;
	/** The user the daemon's stdio connector servers run as; never the engine's or the daemon's. */
	connector?: OsUser;
	/** The connector secrets key; undefined fails closed with `secretsKeyProblem`. */
	secretsKey?: Buffer | undefined;
	secretsKeyProblem?: string;
	/**
	 * Gives the files an older version left as root in the engine's folders to the engine's user, once
	 * at start; default {@link chownHandOver}. From then on everything there is made as that user.
	 */
	handOver?: (paths: string[]) => void;
	/** How the daemon reaches the engine's files; default `engineAccess(engine)` (tests replace it). */
	access?: EngineAccess;
	/** The sign-in helper's command line (`cli.ts --auth-helper`); without it, sign-in is off (B1). */
	authHelper?: AuthHelperCommand;
}

/** The engine's own folders in the data folder (`<data>/<name>`). */
export const ENGINE_DIRS = ["agent", "home", "workspace", "sessions", "gentle-ai"] as const;
/** The stdio connector servers' home and working folder (`<data>/connector-home`), the connector user's. */
export const CONNECTOR_HOME = "connector-home";

export function vpsEnabled(env: NodeJS.ProcessEnv): boolean {
	return ["1", "on", "true"].includes(env.GENTLE_DOT_VPS?.trim().toLowerCase() ?? "");
}

/** A user by name (from `/etc/passwd` text) or as `uid:gid`. */
export function lookupUser(spec: string, passwd: string): OsUser {
	const ids = /^(\d+):(\d+)$/.exec(spec);
	if (ids) return { uid: Number(ids[1]), gid: Number(ids[2]) };
	for (const line of passwd.split("\n")) {
		const [name, , uid, gid] = line.split(":");
		if (name === spec && uid !== undefined && gid !== undefined && /^\d+$/.test(uid) && /^\d+$/.test(gid))
			return { uid: Number(uid), gid: Number(gid) };
	}
	throw new Error(`Server mode: there is no user ${spec} for Gentle Dot to run as.`);
}

/**
 * Server mode from the daemon's environment, or undefined when it is off. Throws when it is on but
 * the separation cannot be made: the daemon is not root, or a user is missing, root, or shared.
 */
export function loadVpsOptions(
	env: NodeJS.ProcessEnv,
	self: { uid: number; passwd?: string },
): VpsOptions | undefined {
	if (!vpsEnabled(env)) return undefined;
	if (self.uid !== 0)
		throw new Error(
			"Server mode (GENTLE_DOT_VPS) needs the daemon to run as root in its container, to start the engine as another user.",
		);
	const passwd = self.passwd ?? readFileSync("/etc/passwd", "utf8");
	const engine = lookupUser(env.GENTLE_DOT_ENGINE_USER || "dot", passwd);
	const connector = lookupUser(env.GENTLE_DOT_CONNECTOR_USER || "dotmcp", passwd);
	if (engine.uid === 0 || connector.uid === 0)
		throw new Error("Server mode: the engine and connector users must not be root.");
	if (engine.uid === connector.uid)
		throw new Error("Server mode: the engine and the connector servers need different users.");
	const text = env[SECRETS_KEY_VAR];
	const secretsKey = parseSecretsKey(text);
	return {
		engine,
		connector,
		secretsKey,
		...(secretsKey ? {} : { secretsKeyProblem: text?.trim() ? BAD_SECRETS_KEY : NO_SECRETS_KEY }),
	};
}

/** The command that hands `paths` to `engine`: only entries `daemon` owns, never through a link. */
export function handOverCommand(engine: OsUser, daemon: OsUser, paths: string[]) {
	return {
		command: "chown",
		args: ["-R", "-P", `--from=${daemon.uid}:${daemon.gid}`, `${engine.uid}:${engine.gid}`, "--", ...paths],
	};
}

/** Hands paths over with GNU chown; a failure is logged, and the engine then cannot use those files. */
export function chownHandOver(engine: OsUser, log: (line: string) => void): (paths: string[]) => void {
	const daemon = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
	return (paths) => {
		if (paths.length === 0) return;
		const { command, args } = handOverCommand(engine, daemon, paths);
		// `-f` is not used: a refusal must be seen. Missing paths are not an error worth a line.
		const result = spawnSync(command, args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
		const problems = (result.stderr ?? "")
			.split("\n")
			.filter((line) => line && !/No such file or directory/.test(line));
		if (result.error || problems.length > 0)
			log(`could not give the engine its files: ${result.error?.message ?? problems.join("; ")}`);
	};
}

/** How the daemon starts a stdio connector server: as the connector user, with no groups or capabilities. */
export function stdioCommand(user: OsUser | undefined, command: string, args: readonly string[]) {
	if (!user) return { command, args: [...args] };
	return {
		command: "setpriv",
		args: [
			`--reuid=${user.uid}`,
			`--regid=${user.gid}`,
			"--clear-groups",
			"--inh-caps=-all",
			"--",
			command,
			...args,
		],
	};
}

/**
 * Lays out the data folder for server mode before the engine starts: the folder itself 0711 and the
 * daemon's, every entry that is not an engine folder the daemon's (an older image ran everything as
 * the engine's user), the identity prompt readable by name, the engine folders handed over, and
 * the connector servers' home given to the connector user.
 */
export function prepareVpsLayout(
	dataDir: string,
	handOver: (paths: string[]) => void,
	connector: OsUser | undefined,
): void {
	const self = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
	lchownSync(dataDir, self.uid, self.gid);
	chmodSync(dataDir, 0o711);
	if (connector) {
		const home = join(dataDir, CONNECTOR_HOME);
		mkdirSync(home, { recursive: true, mode: 0o700 });
		// An entry of the daemon's own folder: no link can stand in for it.
		lchownSync(home, connector.uid, connector.gid);
		chmodSync(home, 0o700);
	}
	const engine = new Set<string>(ENGINE_DIRS);
	for (const name of ENGINE_DIRS) mkdirSync(join(dataDir, name), { recursive: true, mode: 0o700 });
	for (const name of readdirSync(dataDir)) {
		if (engine.has(name) || name === CONNECTOR_HOME) continue;
		const path = join(dataDir, name);
		const stat = lstatSync(path);
		if (stat.uid !== self.uid || stat.gid !== self.gid) lchownSync(path, self.uid, self.gid);
		// Only the identity prompt is the engine's to read; everything else stays private.
		if (!stat.isSymbolicLink())
			chmodSync(path, name === "identity.md" ? 0o644 : stat.isDirectory() ? 0o700 : 0o600);
	}
	handOver(ENGINE_DIRS.map((name) => join(dataDir, name)));
}

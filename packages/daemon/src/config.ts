import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDir, runtimeModules } from "./runtime.ts";

export interface DotConfig {
	port: number;
	host: string;
	dataDir: string;
	/** The engine's own working folder, `<dataDir>/workspace`. */
	workspace: string;
	/** The folder the user chose to work in, when it is not the engine's own workspace. */
	preferredFolder: string | undefined;
	uiDir: string;
	agentCommand: string;
	agentArgs: string[];
	/** The assistant's own Gentle Shell home; undefined for a custom agent script. */
	agentHome: string | undefined;
	allowedOrigins: string[];
}

const DEFAULT_UI_DIR = fileURLToPath(new URL("../../ui/dist/app", import.meta.url));

/**
 * Path of the Gentle Shell launcher bundled with the daemon (the `gentle-pi` dependency),
 * from the runtime's `node_modules` in an installed app.
 */
export function bundledGentleShell(env: NodeJS.ProcessEnv = process.env): string {
	const runtime = runtimeDir(env);
	if (runtime) {
		const bin = join(runtimeModules(runtime), "gentle-pi", "bin", "gentle-shell.mjs");
		if (existsSync(bin)) return bin;
		throw new Error(`The bundled assistant engine is missing from ${runtimeModules(runtime)}.`);
	}
	const require = createRequire(import.meta.url);
	for (const dir of require.resolve.paths("gentle-pi") ?? []) {
		const bin = join(dir, "gentle-pi", "bin", "gentle-shell.mjs");
		if (existsSync(bin)) return bin;
	}
	throw new Error("The bundled assistant engine is missing. Run `pnpm install`.");
}

/** The web UI: the runtime's `ui/` in an installed app, the UI package's build otherwise. */
function uiDirOf(env: NodeJS.ProcessEnv): string {
	const runtime = runtimeDir(env);
	return runtime ? join(runtime, "ui") : DEFAULT_UI_DIR;
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function readFileConfig(dataDir: string): Record<string, unknown> {
	const file = join(dataDir, "config.json");
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Invalid ${file}: ${(error as Error).message}`);
	}
}

function parsePort(value: unknown, source: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error(`Invalid port in ${source}: ${String(value)}`);
	return port;
}

function parseList(value: string | undefined, name: string): string[] {
	if (!value) return [];
	const parsed = JSON.parse(value) as unknown;
	if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
		throw new Error(`${name} must be a JSON array of strings`);
	}
	return parsed;
}

/**
 * The agent is the bundled Gentle Shell by default, run with the assistant's own
 * home so nothing is shared with a Gentle Shell the user may have installed.
 * GENTLE_DOT_AGENT_ARGS marks a custom agent script (tests), which gets no home.
 */
function agentConfig(env: NodeJS.ProcessEnv, dataDir: string) {
	const custom = parseList(env.GENTLE_DOT_AGENT_ARGS, "GENTLE_DOT_AGENT_ARGS");
	const agentHome = resolve(expandHome(env.GENTLE_DOT_AGENT_HOME ?? join(dataDir, "agent")));
	if (env.GENTLE_DOT_AGENT_ARGS)
		return {
			agentCommand: env.GENTLE_DOT_AGENT_BIN ?? process.execPath,
			agentArgs: custom,
			agentHome: undefined,
		};
	if (env.GENTLE_DOT_AGENT_BIN) return { agentCommand: env.GENTLE_DOT_AGENT_BIN, agentArgs: [], agentHome };
	return { agentCommand: process.execPath, agentArgs: [bundledGentleShell(env)], agentHome };
}

/** Resolves configuration from environment variables, then `~/.gentle-dot/config.json`, then defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DotConfig {
	const dataDir = resolve(expandHome(env.GENTLE_DOT_DATA_DIR ?? "~/.gentle-dot"));
	const file = readFileConfig(dataDir);
	// The engine always works in its own workspace, which names its memory project; a
	// folder the user chose is passed to the engine as the place to work in.
	const workspace = join(dataDir, "workspace");
	const chosen =
		env.GENTLE_DOT_WORKSPACE ?? (typeof file.workspace === "string" ? file.workspace : undefined);
	const preferredFolder = chosen ? resolve(expandHome(chosen)) : undefined;
	return {
		port: env.GENTLE_DOT_PORT
			? parsePort(env.GENTLE_DOT_PORT, "GENTLE_DOT_PORT")
			: parsePort(file.port ?? 4317, "config.json"),
		host: env.GENTLE_DOT_HOST ?? "127.0.0.1",
		dataDir,
		workspace,
		preferredFolder: preferredFolder === workspace ? undefined : preferredFolder,
		uiDir: resolve(env.GENTLE_DOT_UI_DIR ?? uiDirOf(env)),
		...agentConfig(env, dataDir),
		allowedOrigins: parseList(env.GENTLE_DOT_ALLOWED_ORIGINS, "GENTLE_DOT_ALLOWED_ORIGINS"),
	};
}

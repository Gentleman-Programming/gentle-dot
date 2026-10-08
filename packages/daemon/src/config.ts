import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DotConfig {
	port: number;
	host: string;
	dataDir: string;
	workspace: string;
	uiDir: string;
	agentCommand: string;
	agentArgs: string[];
	allowedOrigins: string[];
}

const DEFAULT_UI_DIR = fileURLToPath(new URL("../../ui/dist/app", import.meta.url));

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

/** Resolves configuration from environment variables, then `~/.gentle-dot/config.json`, then defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DotConfig {
	const dataDir = resolve(expandHome(env.GENTLE_DOT_DATA_DIR ?? "~/.gentle-dot"));
	const file = readFileConfig(dataDir);
	return {
		port: env.GENTLE_DOT_PORT
			? parsePort(env.GENTLE_DOT_PORT, "GENTLE_DOT_PORT")
			: parsePort(file.port ?? 4317, "config.json"),
		host: env.GENTLE_DOT_HOST ?? "127.0.0.1",
		dataDir,
		workspace: resolve(
			expandHome(env.GENTLE_DOT_WORKSPACE ?? (typeof file.workspace === "string" ? file.workspace : "~")),
		),
		uiDir: resolve(env.GENTLE_DOT_UI_DIR ?? DEFAULT_UI_DIR),
		agentCommand: env.GENTLE_DOT_AGENT_BIN ?? "gentle-shell",
		agentArgs: parseList(env.GENTLE_DOT_AGENT_ARGS, "GENTLE_DOT_AGENT_ARGS"),
		allowedOrigins: parseList(env.GENTLE_DOT_ALLOWED_ORIGINS, "GENTLE_DOT_ALLOWED_ORIGINS"),
	};
}

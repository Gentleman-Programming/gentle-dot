/**
 * Finds the MCP servers the user set up in other apps (S20), read-only: Claude Desktop, Claude Code,
 * Cursor, VS Code, Windsurf, OpenCode, and Gentle Shell, on macOS and Linux. Each entry is mapped to
 * the engine's `mcp.json` schema. Values keep their meaning: a literal stays a literal (escaped, so
 * the engine neither runs it as `!command` nor expands `$NAME`), an environment reference becomes the
 * engine's `${NAME}`, and a VS Code input becomes a value the user types in the app (`${input:<id>}`).
 * The source files are only read; nothing here writes anywhere.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ImportCandidate } from "@gentle-dot/protocol";
import { literal, type ServerTemplate, type SetupField } from "./connectors.ts";

/** One server found in one app's configuration. */
export interface ScannedServer {
	/** The app it was found in. */
	source: string;
	name: string;
	transport: ImportCandidate["transport"];
	/** The engine's server entry; undefined when it cannot be imported. */
	server?: ServerTemplate;
	/** Values the user types after the import. */
	fields: SetupField[];
	/** Signs in with OAuth: a remote server without an `Authorization` header. */
	oauth: boolean;
	reason?: string;
}

/** How an app writes references in its values. */
type Syntax = "literal" | "claude-code" | "vscode" | "opencode" | "engine";

const SSE_REASON = "It uses the old SSE transport, which the assistant does not support.";
const NO_SERVER = "It has no command or address the assistant can use.";
const MAX_FILE = 50 * 1024 * 1024;
const MAX_PROJECTS = 200;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INPUT_ID = /^[A-Za-z0-9_.-]{1,64}$/;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Every server in the known configuration files below `home`; files that are missing or broken are skipped. */
export function scanClientConfigs(home: string): ScannedServer[] {
	const found: ScannedServer[] = [];
	const read = (path: string) => readJson(join(home, path));
	const add = (source: string, servers: unknown, syntax: Syntax, inputs?: unknown) => {
		if (!isRecord(servers)) return;
		const fields = inputFields(inputs);
		for (const [name, raw] of Object.entries(servers))
			if (isRecord(raw)) found.push(mapServer(source, name, raw, { syntax, home, inputs: fields }));
	};

	for (const path of [
		"Library/Application Support/Claude/claude_desktop_config.json",
		".config/Claude/claude_desktop_config.json",
	])
		add("Claude Desktop", read(path)?.mcpServers, "literal");

	const claude = read(".claude.json");
	add("Claude Code", claude?.mcpServers, "claude-code");
	const projects = isRecord(claude?.projects) ? Object.entries(claude.projects).slice(0, MAX_PROJECTS) : [];
	for (const [folder, project] of projects) {
		if (isRecord(project)) add("Claude Code", project.mcpServers, "claude-code");
		if (isAbsolute(folder))
			add("Claude Code", readJson(join(folder, ".mcp.json"))?.mcpServers, "claude-code");
	}

	add("Cursor", read(".cursor/mcp.json")?.mcpServers, "vscode");
	for (const path of ["Library/Application Support/Code/User/mcp.json", ".config/Code/User/mcp.json"]) {
		const vscode = read(path);
		add("VS Code", vscode?.servers, "vscode", vscode?.inputs);
	}
	add("Windsurf", read(".codeium/windsurf/mcp_config.json")?.mcpServers, "vscode");

	const opencode = read(".config/opencode/opencode.json");
	if (isRecord(opencode?.mcp))
		for (const [name, raw] of Object.entries(opencode.mcp))
			if (isRecord(raw))
				found.push(mapServer("OpenCode", name, openCodeEntry(raw), { syntax: "opencode", home }));

	add("Gentle Shell", read(".gentle-shell/agent/mcp.json")?.mcpServers, "engine");
	return found;
}

function readJson(path: string): Json | undefined {
	try {
		if (!existsSync(path) || statSync(path).size > MAX_FILE) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** OpenCode keeps the command line in one array and the environment under `environment`. */
function openCodeEntry(raw: Json): Json {
	if (raw.type === "local" && Array.isArray(raw.command)) {
		const [command, ...args] = raw.command;
		return { command, args, env: raw.environment };
	}
	return { url: raw.url, headers: raw.headers };
}

/** VS Code's `inputs`: values its own app asks for, by id. */
function inputFields(inputs: unknown): Map<string, SetupField> {
	const fields = new Map<string, SetupField>();
	if (!Array.isArray(inputs)) return fields;
	for (const input of inputs) {
		if (!isRecord(input) || typeof input.id !== "string" || !INPUT_ID.test(input.id)) continue;
		const label = typeof input.description === "string" && input.description ? input.description : input.id;
		fields.set(input.id, { key: input.id, label, secret: input.password === true });
	}
	return fields;
}

interface MapContext {
	syntax: Syntax;
	home: string;
	inputs?: Map<string, SetupField>;
}

function mapServer(source: string, name: string, raw: Json, context: MapContext): ScannedServer {
	const used: SetupField[] = [];
	const convert = new Converter(context, used);
	const url =
		typeof raw.url === "string" ? raw.url : typeof raw.serverUrl === "string" ? raw.serverUrl : undefined;
	const base = { source, name, fields: used, oauth: false };
	if (raw.type === "sse" || (url && raw.type === undefined && raw.command === undefined && isSsePath(url)))
		return { ...base, transport: "sse", reason: SSE_REASON };
	if (typeof raw.command === "string" && raw.command !== "") {
		const server: ServerTemplate = { command: convert.raw(raw.command) };
		if (Array.isArray(raw.args) && raw.args.length > 0)
			server.args = raw.args
				.filter((arg): arg is string => typeof arg === "string")
				.map((arg) => convert.raw(arg));
		const env = convert.record(raw.env);
		if (env) server.env = env;
		if (typeof raw.cwd === "string" && raw.cwd) server.cwd = convert.raw(raw.cwd);
		return { ...base, transport: "stdio", server };
	}
	if (url && URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)) {
		const server: ServerTemplate = { url: convert.raw(url) };
		const headers = convert.record(raw.headers);
		if (headers) server.headers = headers;
		const oauth = context.syntax === "engine" ? engineOAuth(raw.oauth) : undefined;
		if (oauth) server.oauth = oauth;
		const authorized = Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "authorization");
		return { ...base, transport: "http", server, oauth: !authorized };
	}
	return { ...base, transport: url ? "http" : "stdio", reason: NO_SERVER };
}

/**
 * What the engine does with each value it resolves (env, headers, the OAuth client secret) when the
 * server starts, in plain words: a leading `!` runs a command, and `$NAME` or `${NAME}` reads an
 * environment variable (`$$` and `$!` are literals). The command itself is never repeated.
 */
export function valueNotes(server: ServerTemplate): string[] {
	const values: [string, string][] = [
		...Object.entries("command" in server ? (server.env ?? {}) : (server.headers ?? {})),
		...("url" in server && server.oauth?.clientSecret !== undefined
			? [["Client Secret", server.oauth.clientSecret] as [string, string]]
			: []),
	];
	return values.flatMap(([key, text]) => {
		if (text.startsWith("!")) return [`${key}: Runs a command on your computer to get this value.`];
		const names = envReferences(text);
		if (names.length === 0) return [];
		const list = names.join(", ");
		return [`${key}: Reads the environment variable${names.length > 1 ? "s" : ""} ${list}.`];
	});
}

/** The environment variables a value reads, as the engine parses its templates. */
function envReferences(text: string): string[] {
	const names: string[] = [];
	for (let index = text.indexOf("$"); index >= 0; index = text.indexOf("$", index)) {
		const next = text[index + 1];
		if (next === "$" || next === "!") {
			index += 2;
			continue;
		}
		const braced = next === "{" ? /^\$\{([^}]*)\}/.exec(text.slice(index)) : undefined;
		const name = braced ? braced[1] : /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(index))?.[1];
		if (name && ENV_NAME.test(name) && !names.includes(name)) names.push(name);
		index += braced ? braced[0].length : 1 + (name?.length ?? 0);
	}
	return names;
}

function isSsePath(url: string): boolean {
	return URL.canParse(url) && /\/sse\/?$/i.test(new URL(url).pathname);
}

/** A Gentle Shell server's own OAuth client settings, which use the engine's schema already. */
function engineOAuth(
	value: unknown,
): NonNullable<Extract<ServerTemplate, { url: string }>["oauth"]> | undefined {
	if (!isRecord(value)) return undefined;
	const oauth: NonNullable<Extract<ServerTemplate, { url: string }>["oauth"]> = {};
	for (const key of ["clientId", "clientSecret", "callbackUrl", "scope"] as const)
		if (typeof value[key] === "string") oauth[key] = value[key] as string;
	if (Number.isInteger(value.callbackPort)) oauth.callbackPort = value.callbackPort as number;
	return Object.keys(oauth).length > 0 ? oauth : undefined;
}

/** References each app expands in its values, as one pattern per syntax. */
const REFERENCES: Record<Exclude<Syntax, "literal" | "engine">, RegExp> = {
	// `${NAME}` and `${NAME:-default}` (the default is dropped: the engine has none).
	"claude-code": /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g,
	// `${env:NAME}`, `${input:id}`, and `${userHome}` (VS Code, Cursor, Windsurf).
	vscode: /\$\{(?:env:([A-Za-z_][A-Za-z0-9_]*)|input:([A-Za-z0-9_.-]{1,64})|(userHome))\}/g,
	// `{env:NAME}`.
	opencode: /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
};

class Converter {
	private readonly context: MapContext;
	private readonly used: SetupField[];

	constructor(context: MapContext, used: SetupField[]) {
		this.context = context;
		this.used = used;
	}

	/** A value the engine resolves (env, headers): references kept, the rest literal. */
	value(text: string): string {
		const { syntax } = this.context;
		if (syntax === "engine") return text;
		if (syntax === "literal") return literal(text);
		return this.replace(text, REFERENCES[syntax], literal, (name) => `\${${name}}`);
	}

	/** A value the engine uses as written (command, args, url): only inputs and the home folder are filled. */
	raw(text: string): string {
		if (this.context.syntax !== "vscode") return text;
		return this.replace(
			text,
			REFERENCES.vscode,
			(part) => part,
			(_name, match) => match,
		);
	}

	record(value: unknown): Record<string, string> | undefined {
		if (!isRecord(value)) return undefined;
		const out: Record<string, string> = {};
		for (const [key, entry] of Object.entries(value))
			if (typeof entry === "string" && ENV_NAME.test(key.replace(/-/g, "_"))) out[key] = this.value(entry);
		return Object.keys(out).length > 0 ? out : undefined;
	}

	private replace(
		text: string,
		pattern: RegExp,
		plain: (part: string) => string,
		env: (name: string, match: string) => string,
	): string {
		let out = "";
		let last = 0;
		for (const match of text.matchAll(pattern)) {
			out += plain(text.slice(last, match.index));
			last = match.index + match[0].length;
			const [whole, name, input, home] = match;
			if (input) out += this.input(input);
			else if (home) out += plain(this.context.home);
			else out += env(name ?? "", whole);
		}
		return out + plain(text.slice(last));
	}

	/** A VS Code input: a value the user types in the app after the import. */
	private input(id: string): string {
		const field = this.context.inputs?.get(id) ?? { key: id, label: id, secret: true };
		if (!this.used.some((f) => f.key === id)) this.used.push(field);
		return `\${input:${id}}`;
	}
}

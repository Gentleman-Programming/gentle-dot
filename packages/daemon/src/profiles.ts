import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	type AuthProvider,
	isThinkingLevel,
	isValidProfileName,
	type ModelOption,
	type Profile,
	type ProfileRole,
	type ProfileRoles,
	parseProfileRoles,
	type RoleRoute,
} from "@gentle-dot/protocol";
import { presentText } from "./white-label.ts";

// The engine's profile store format (gentle-pi lib/agent-profiles.ts), reimplemented
// so the assistant can manage profiles without the terminal-only `/gentle:profiles`.
const PROFILES_KIND = "gentle-pi.agent_model_profiles";
const PROFILES_VERSION = 1;
const ORCHESTRATOR = "orchestrator";
/** Review roles route through models.json only; they are never written to subagents.json. */
const REVIEW_ROLES = ["review-refuter", "review-validator"];
const ROLE_NAME = /^[A-Za-z0-9._:@/+%-]+$/;
const MODEL_ID = /^[A-Za-z0-9._~:@/+%-]+$/;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;

export interface ProfilesFile {
	active?: string;
	profiles: Record<string, ProfileRoles>;
}

export type ProfileErrorCode =
	| "invalid_name"
	| "duplicate_name"
	| "missing_profile"
	| "active_profile"
	| "store_invalid"
	| "settings_invalid"
	| "nothing_to_import";

const MESSAGES: Record<ProfileErrorCode, string> = {
	invalid_name:
		"Profile names use 1-64 letters, numbers, dots, dashes, or underscores, starting with a letter or number.",
	duplicate_name: "A profile with that name already exists.",
	missing_profile: "That profile does not exist anymore.",
	active_profile: "That profile is in use. Switch to another one before deleting it.",
	store_invalid: "The saved profiles could not be read, so nothing was changed.",
	settings_invalid: "The assistant's settings could not be read, so the profile was not applied.",
	nothing_to_import: "There are no profiles to import.",
};

/** A profile operation the user can fix; `message` is safe to show. */
export class ProfileError extends Error {
	readonly code: ProfileErrorCode;

	constructor(code: ProfileErrorCode) {
		super(MESSAGES[code]);
		this.name = "ProfileError";
		this.code = code;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** One route as the engine normalizes it: a bare string is a model, `effort` aliases `thinking`. */
function normalizeRoute(value: unknown): RoleRoute | undefined {
	if (typeof value === "string") {
		const model = value.trim();
		return model && MODEL_ID.test(model) ? { model } : undefined;
	}
	if (!isRecord(value)) return undefined;
	const model =
		typeof value.model === "string" && MODEL_ID.test(value.model.trim()) ? value.model.trim() : undefined;
	const thinking = isThinkingLevel(value.thinking)
		? value.thinking
		: isThinkingLevel(value.effort)
			? value.effort
			: undefined;
	if (!model && !thinking) return Object.keys(value).length === 0 ? {} : undefined;
	const route: RoleRoute = {};
	if (model) route.model = model;
	if (thinking) route.thinking = thinking;
	return route;
}

function normalizeRoles(value: unknown): ProfileRoles | undefined {
	if (!isRecord(value)) return undefined;
	const roles: ProfileRoles = {};
	for (const [role, raw] of Object.entries(value)) {
		if (!ROLE_NAME.test(role)) continue;
		const route = normalizeRoute(raw);
		if (route) roles[role] = route;
	}
	return roles;
}

/** Parses a profile store; undefined when it is not one. Invalid entries are dropped like the engine does. */
export function parseProfilesFile(text: string): ProfilesFile | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.kind !== PROFILES_KIND || value.version !== PROFILES_VERSION)
		return undefined;
	if (!isRecord(value.profiles)) return undefined;
	const profiles: Record<string, ProfileRoles> = {};
	for (const [name, raw] of Object.entries(value.profiles)) {
		const roles = isValidProfileName(name) ? normalizeRoles(raw) : undefined;
		if (roles) profiles[name] = roles;
	}
	const file: ProfilesFile = { profiles };
	if (typeof value.active === "string" && Object.hasOwn(profiles, value.active)) file.active = value.active;
	return file;
}

/** Serializes in the engine's key order: kind, version, profiles, active. */
export function serializeProfilesFile(file: ProfilesFile): string {
	const payload: Record<string, unknown> = {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		profiles: file.profiles,
	};
	if (file.active !== undefined) payload.active = file.active;
	return `${JSON.stringify(payload, null, 2)}\n`;
}

const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Replaces a file through a sibling temp file (mode 0600) and a rename, so readers never see a partial file. */
export function writeFileAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		writeFileSync(fd, text);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Reads a JSON object file; missing is `{}`, anything else that is not an object throws `code`. */
function readObject(path: string, code: ProfileErrorCode): Record<string, unknown> {
	const text = readText(path);
	if (text === undefined) return {};
	try {
		const value: unknown = JSON.parse(text);
		if (isRecord(value)) return value;
	} catch {}
	throw new ProfileError(code);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` holding the same lock Pi's settings storage takes (proper-lockfile:
 * a `<file>.lock` directory, stale after 10 seconds), so the engine never
 * interleaves its own settings write with ours.
 */
async function withFileLock<T>(path: string, fn: () => T): Promise<T> {
	mkdirSync(dirname(path), { recursive: true });
	const lock = `${path}.lock`;
	for (let attempt = 0; ; attempt++) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let stale = false;
			try {
				stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
			} catch {}
			if (stale) rmSync(lock, { recursive: true, force: true });
			else if (attempt >= LOCK_ATTEMPTS) throw new Error(`${path} stayed locked`);
			else await sleep(LOCK_RETRY_MS);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

function splitModel(model: string): { provider: string; modelId: string } | undefined {
	const at = model.indexOf("/");
	if (at <= 0 || at === model.length - 1) return undefined;
	return { provider: model.slice(0, at), modelId: model.slice(at + 1) };
}

/** The user's own Gentle Shell profile store, from the daemon's environment (never the engine child's). */
export function defaultImportPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.GENTLE_PI_CONFIG_HOME || join(homedir(), ".pi", "gentle-ai"), "profiles.json");
}

export interface ProfileStoreOptions {
	/** The assistant's profile store directory (`GENTLE_PI_CONFIG_HOME` of its engine). */
	configHome: string;
	/** The assistant's engine home (`--home`). */
	agentHome: string;
	/** Another setup's `profiles.json`, only ever read, for the one-time import. */
	importPath: string;
}

export interface ImportResult {
	imported: { from: string; to: string }[];
	/** Accounts the imported profiles use that are not connected yet. */
	missingProviders: string[];
}

/**
 * The assistant's own profiles: the engine's store format and the files the
 * engine reads when it routes models. Every write goes through one queue.
 */
export class ProfileStore {
	private readonly options: ProfileStoreOptions;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: ProfileStoreOptions) {
		this.options = options;
	}

	private get storePath(): string {
		return join(this.options.configHome, "profiles.json");
	}

	private get modelsPath(): string {
		return join(this.options.configHome, "models.json");
	}

	private get subagentsPath(): string {
		return join(this.options.agentHome, "subagents.json");
	}

	private get settingsPath(): string {
		return join(this.options.agentHome, "settings.json");
	}

	list(): { profiles: Profile[]; active?: string } {
		const file = this.read();
		const profiles = Object.entries(file.profiles)
			.map(([name, roles]) => ({ name, roles }))
			.sort((a, b) => a.name.localeCompare(b.name));
		return file.active === undefined ? { profiles } : { profiles, active: file.active };
	}

	/** Roles the user can route, including any a saved profile routes without an agent file. */
	roles(): ProfileRole[] {
		const routed = Object.values(this.read().profiles).flatMap((roles) => Object.keys(roles));
		return discoverRoles(this.options.agentHome, routed);
	}

	/** Creates or replaces a profile. */
	save(name: string, roles: ProfileRoles): Promise<void> {
		return this.mutate((file) => {
			requireName(name);
			file.profiles[name] = cleanRoles(roles);
		});
	}

	rename(from: string, to: string): Promise<void> {
		return this.mutate((file) => {
			requireExisting(file, from);
			requireFree(file, to);
			file.profiles = Object.fromEntries(
				Object.entries(file.profiles).map(([name, roles]) => [name === from ? to : name, roles]),
			);
			if (file.active === from) file.active = to;
		});
	}

	duplicate(from: string, to: string): Promise<void> {
		return this.mutate((file) => {
			const roles = requireExisting(file, from);
			requireFree(file, to);
			file.profiles[to] = structuredClone(roles);
		});
	}

	remove(name: string): Promise<void> {
		return this.mutate((file) => {
			requireExisting(file, name);
			if (file.active === name) throw new ProfileError("active_profile");
			delete file.profiles[name];
		});
	}

	/** Saves the routing in effect now; `orchestrator` comes from the running assistant. */
	saveCurrent(name: string, orchestrator?: RoleRoute): Promise<void> {
		return this.mutate((file) => {
			requireFree(file, name);
			const roles: ProfileRoles = {};
			const modelProfiles = readObject(this.subagentsPath, "settings_invalid").model_profiles;
			for (const [agent, raw] of Object.entries(isRecord(modelProfiles) ? modelProfiles : {})) {
				const route = isRecord(raw) ? normalizeRoute(raw) : undefined;
				if (route && ROLE_NAME.test(agent)) roles[agent] = route;
			}
			const models = readObject(this.modelsPath, "settings_invalid");
			for (const role of REVIEW_ROLES) {
				const route = normalizeRoute(models[role]);
				if (route) roles[role] = route;
			}
			if (orchestrator) roles[ORCHESTRATOR] = orchestrator;
			file.profiles[name] = cleanRoles(roles);
		});
	}

	/**
	 * Applies a profile the way the engine does: the active marker, then
	 * models.json, then subagents.json `model_profiles` (omitted agents cleared),
	 * then the main assistant's defaults in settings.json. Agent files are never
	 * rewritten. Any failure restores all four files. Returns the main assistant
	 * route when the profile sets its model.
	 */
	apply(name: string): Promise<RoleRoute | undefined> {
		return this.enqueue(async () => {
			const file = this.read();
			const roles = requireExisting(file, name);
			const paths = [this.storePath, this.modelsPath, this.subagentsPath, this.settingsPath];
			const before = paths.map(readText);
			try {
				writeFileAtomic(this.storePath, serializeProfilesFile({ ...file, active: name }));
				writeFileAtomic(this.modelsPath, jsonText(roles));
				this.writeAgentRoutes(roles);
				const orchestrator = roles[ORCHESTRATOR];
				if (!orchestrator?.model) return undefined;
				await this.writeOrchestrator(orchestrator);
				return { ...orchestrator };
			} catch (error) {
				paths.forEach((path, i) => {
					const text = before[i];
					if (text === undefined) rmSync(path, { force: true });
					else writeFileAtomic(path, text);
				});
				throw error;
			}
		});
	}

	/** True when the other setup has at least one profile to bring over. */
	importable(): boolean {
		if (this.options.importPath === this.storePath) return false;
		const source = this.readSource();
		return source !== undefined && Object.keys(source.profiles).length > 0;
	}

	/**
	 * Copies the other setup's profiles into the assistant's store. Names that are
	 * taken get `-imported`, `-imported-2`, …; identical copies are skipped, and
	 * the other setup's active marker is not copied.
	 */
	import(providers: AuthProvider[] = []): Promise<ImportResult> {
		return this.enqueue(() => {
			const source = this.importable() ? this.readSource() : undefined;
			if (!source) throw new ProfileError("nothing_to_import");
			const file = this.read();
			const imported: ImportResult["imported"] = [];
			const used = new Set<string>();
			for (const [name, roles] of Object.entries(source.profiles)) {
				const target = importName(file, name, roles);
				if (!target) continue;
				file.profiles[target] = roles;
				imported.push({ from: name, to: target });
				for (const route of Object.values(roles)) {
					const provider = route.model ? splitModel(route.model)?.provider : undefined;
					if (provider) used.add(provider);
				}
			}
			if (imported.length > 0) writeFileAtomic(this.storePath, serializeProfilesFile(file));
			const missingProviders = [...used]
				.filter((id) => !providers.some((p) => p.id === id && p.configured))
				.map((id) => providers.find((p) => p.id === id)?.name ?? id)
				.sort();
			return { imported, missingProviders };
		});
	}

	private writeAgentRoutes(roles: ProfileRoles): void {
		const config = readObject(this.subagentsPath, "settings_invalid");
		const modelProfiles: Record<string, Record<string, string>> = {};
		for (const [agent, route] of Object.entries(roles)) {
			if (agent === ORCHESTRATOR || REVIEW_ROLES.includes(agent)) continue;
			const entry: Record<string, string> = {};
			if (route.model) entry.model = route.model;
			if (route.thinking) entry.effort = route.thinking;
			if (Object.keys(entry).length > 0) modelProfiles[agent] = entry;
		}
		const next = { ...config };
		if (Object.keys(modelProfiles).length > 0) next.model_profiles = modelProfiles;
		else delete next.model_profiles;
		writeFileAtomic(this.subagentsPath, jsonText(next));
	}

	private writeOrchestrator(route: RoleRoute): Promise<void> {
		const target = route.model ? splitModel(route.model) : undefined;
		if (!target) throw new ProfileError("settings_invalid");
		return withFileLock(this.settingsPath, () => {
			const settings = readObject(this.settingsPath, "settings_invalid");
			const next: Record<string, unknown> = {
				...settings,
				defaultProvider: target.provider,
				defaultModel: target.modelId,
			};
			if (route.thinking) next.defaultThinkingLevel = route.thinking;
			else delete next.defaultThinkingLevel;
			writeFileAtomic(this.settingsPath, jsonText(next));
		});
	}

	private read(): ProfilesFile {
		const text = readText(this.storePath);
		if (text === undefined) return { profiles: {} };
		const file = parseProfilesFile(text);
		if (!file) throw new ProfileError("store_invalid");
		return file;
	}

	private readSource(): ProfilesFile | undefined {
		const text = readText(this.options.importPath);
		return text === undefined ? undefined : parseProfilesFile(text);
	}

	private mutate(change: (file: ProfilesFile) => void): Promise<void> {
		return this.enqueue(() => {
			const file = this.read();
			change(file);
			writeFileAtomic(this.storePath, serializeProfilesFile(file));
		});
	}

	private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => {});
		return run;
	}
}

function requireName(name: string): void {
	if (!isValidProfileName(name)) throw new ProfileError("invalid_name");
}

function requireExisting(file: ProfilesFile, name: string): ProfileRoles {
	requireName(name);
	const roles = Object.hasOwn(file.profiles, name) ? file.profiles[name] : undefined;
	if (!roles) throw new ProfileError("missing_profile");
	return roles;
}

function requireFree(file: ProfilesFile, name: string): void {
	requireName(name);
	if (Object.hasOwn(file.profiles, name)) throw new ProfileError("duplicate_name");
}

function cleanRoles(roles: ProfileRoles): ProfileRoles {
	return parseProfileRoles(roles) ?? {};
}

/** The free name for an imported profile, or undefined when an identical copy is already saved. */
function importName(file: ProfilesFile, name: string, roles: ProfileRoles): string | undefined {
	const same = (other: string) => JSON.stringify(file.profiles[other]) === JSON.stringify(roles);
	for (let n = 0; ; n++) {
		const suffix = n === 0 ? "" : n === 1 ? "-imported" : `-imported-${n}`;
		const candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`;
		if (!Object.hasOwn(file.profiles, candidate)) return candidate;
		if (same(candidate)) return undefined;
	}
}

const ROLE_LABELS: Record<string, string> = {
	[ORCHESTRATOR]: "Main assistant",
	"gentle-ai-explore": "Researcher",
	"gentle-ai-worker": "Builder",
	"gentle-ai-verify": "Checker",
	"review-refuter": "Reviewer: challenger",
	"review-validator": "Reviewer: validator",
	"jd-judge-a": "Second opinion A",
	"jd-judge-b": "Second opinion B",
	"jd-fix-agent": "Second opinion fixer",
};

/** A plain-language, white-labeled name for a role id. */
export function roleLabel(id: string): string {
	const known = ROLE_LABELS[id];
	if (known) return known;
	const review = /^review-(.+)$/.exec(id);
	if (review?.[1]) return `Reviewer: ${review[1].replace(/[-_]+/g, " ")}`;
	const words = id
		.replace(/^gentle[-_]?(?:ai|pi|shell)?[-_]/i, "")
		.replace(/[-_.]+/g, " ")
		.trim();
	const label = presentText(words.charAt(0).toUpperCase() + words.slice(1));
	return label || "Helper";
}

/** Agent names the engine discovers in `<home>/agents` and `<home>/subagents` (top-level `.md`, frontmatter `name:`). */
function agentNames(agentHome: string): string[] {
	const names: string[] = [];
	for (const dir of [join(agentHome, "agents"), join(agentHome, "subagents")]) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir).sort()) {
			if (!entry.toLowerCase().endsWith(".md") || entry.toLowerCase().endsWith(".chain.md")) continue;
			const text = readText(join(dir, entry)) ?? "";
			const name =
				/^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(text)?.[1]?.trim() || entry.replace(/\.md$/i, "");
			if (ROLE_NAME.test(name)) names.push(name);
		}
	}
	return names;
}

/** The roles a profile can route: the main assistant first, then agents and review roles by label. */
export function discoverRoles(agentHome: string, extra: string[] = []): ProfileRole[] {
	const ids = new Set([...agentNames(agentHome), ...REVIEW_ROLES, ...extra]);
	ids.delete(ORCHESTRATOR);
	const roles = [...ids]
		.map((id) => ({ id, label: roleLabel(id) }))
		.sort((a, b) => a.label.localeCompare(b.label));
	return [{ id: ORCHESTRATOR, label: roleLabel(ORCHESTRATOR) }, ...roles];
}

/** Models from `get_available_models`, reduced to what the UI needs: never endpoints, headers, or costs. */
export function toModelOptions(data: unknown): ModelOption[] {
	const models = isRecord(data) && Array.isArray(data.models) ? data.models : [];
	return models.flatMap((raw): ModelOption[] => {
		if (!isRecord(raw) || typeof raw.provider !== "string" || typeof raw.id !== "string") return [];
		const name = typeof raw.name === "string" && raw.name ? raw.name : raw.id;
		return [
			{ provider: raw.provider, id: raw.id, name: presentText(name), reasoning: raw.reasoning === true },
		];
	});
}

/** The part of the supervisor the live switch needs. */
export interface LiveAgent {
	busy: boolean;
	state: string;
	request(command: { type: string; [key: string]: unknown }): Promise<unknown>;
}

export type SwitchOutcome = "switched" | "deferred" | "failed" | "none";

/**
 * The running conversation keeps the model it started with, so applying a
 * profile also switches it live (`set_model`, `set_thinking_level`); while the
 * assistant is busy the switch waits for `settle()`.
 */
export class LiveModelSwitch {
	private readonly agent: LiveAgent;
	private readonly log: (line: string) => void;
	private pending: RoleRoute | undefined;

	constructor(agent: LiveAgent, log: (line: string) => void = () => {}) {
		this.agent = agent;
		this.log = log;
	}

	switchTo(route: RoleRoute): Promise<SwitchOutcome> {
		this.pending = route;
		return this.settle("deferred");
	}

	/** Runs a waiting switch once the assistant is ready and idle. */
	async settle(waiting: SwitchOutcome = "none"): Promise<SwitchOutcome> {
		const route = this.pending;
		if (!route) return "none";
		if (this.agent.busy || this.agent.state !== "ready") return waiting;
		this.pending = undefined;
		const target = route.model ? splitModel(route.model) : undefined;
		if (!target) return "none";
		try {
			await this.agent.request({ type: "set_model", ...target });
			if (route.thinking) await this.agent.request({ type: "set_thinking_level", level: route.thinking });
			return "switched";
		} catch (error) {
			this.log(`could not switch the running model: ${(error as Error).message}`);
			return "failed";
		}
	}
}

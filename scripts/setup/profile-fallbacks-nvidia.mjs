#!/usr/bin/env node
// Adds an NVIDIA ladder to every profile fallback chain so a nan provider that runs out of
// quota (402) or loses its key (401) switches to NVIDIA inside the same session instead of
// dropping the connection.
//
// Run it yourself: model configuration is human-controlled, so no agent tool can write it.
//
//   node scripts/setup/profile-fallbacks-nvidia.mjs --check     # validate only, no writes
//   node scripts/setup/profile-fallbacks-nvidia.mjs             # apply (keeps .bak backups)
//   node scripts/setup/profile-fallbacks-nvidia.mjs --dry-run   # show what would change
//
// Why the ladder looks like that: every nvidia id must exist in the installed pi-ai catalog
// (providers/data/nvidia.json), the provider needs a key in the engine's auth.json, and the
// chain may hold at most 8 steps (lib/model-fallback-store.ts MAX_CHAIN_LENGTH). Steps whose
// model is not in the nan catalog are dropped: they can only produce a 401, and a 401 puts the
// model in a 30-minute cooldown without ever serving a turn.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Ids the nan provider actually serves; anything else in a chain is dead weight. */
const LIVE_NAN = new Set(["nan/deepseek-v4-flash", "nan/glm5.3-flash"]);

/** Ordered NVIDIA steps appended to every chain (provider `nvidia`, zero cost, big context). */
export const NVIDIA_LADDER = [
	{ model: "nvidia/z-ai/glm-5.3-flash" },
	{ model: "nvidia/deepseek-ai/deepseek-v4.1-flash" },
	{ model: "nvidia/nvidia/nemotron-3-ultra-550b-a55b" },
];

const KIND = "gentle-pi.profile_model_fallbacks";
const MAX_CHAIN_LENGTH = 8;
// The store's own limits (gentle-pi lib/model-fallback-store.ts, lib/agent-profiles.ts,
// lib/model-routing-authority.ts). Matching them matters in both directions: the store drops a
// file it rejects wholesale, so a stricter check here would call a legal file invalid and a
// looser one would report "válido" for a file that silently disables every fallback.
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SAFE_MODEL_ID = /^[A-Za-z0-9._~:@/+%-]+$/;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_NAME = /^[A-Za-z0-9._:@/+%-]+$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

/** Config homes that may hold a fallback store; missing ones are skipped. */
export const CONFIG_HOMES = [
	join(homedir(), ".gentle-dot", "gentle-ai"),
	join(homedir(), ".gentle-shell", "config", "gentle-ai"),
	join(homedir(), ".pi", "gentle-ai"),
];

/**
 * Returns `doc` with every chain extended: live nan steps first, then the NVIDIA ladder,
 * dead ids removed, duplicates collapsed and the length cap respected. Idempotent.
 */
export function extendChains(doc, ladder = NVIDIA_LADDER) {
	const profiles = {};
	for (const [profile, chains] of Object.entries(doc.profiles)) {
		const next = {};
		for (const [role, steps] of Object.entries(chains)) {
			const kept = steps.filter((s) => LIVE_NAN.has(s.model));
			const primary = kept.length > 0 ? kept : [{ model: "nan/deepseek-v4-flash" }];
			const seen = new Set(primary.map((s) => s.model));
			const out = [...primary.map((s) => ({ ...s }))];
			for (const step of ladder) {
				if (!seen.has(step.model)) {
					out.push({ ...step });
					seen.add(step.model);
				}
			}
			next[role] = out.slice(0, MAX_CHAIN_LENGTH);
		}
		profiles[profile] = next;
	}
	return { ...doc, profiles };
}

/** Every structural rule the store enforces when it loads the file. Returns the problems found. */
export function validate(doc) {
	const problems = [];
	const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
	if (!isRecord(doc)) return ["el store no es un objeto"];
	const keys = Object.keys(doc).sort().join(",");
	if (keys !== "kind,profiles,version") problems.push(`claves inesperadas: ${keys}`);
	if (doc.kind !== KIND) problems.push(`kind inválido: ${doc.kind}`);
	if (doc.version !== 1) problems.push(`version inválida: ${doc.version}`);
	if (!isRecord(doc.profiles)) return [...problems, "profiles no es un objeto"];
	for (const [profile, chains] of Object.entries(doc.profiles)) {
		if (!PROFILE_NAME.test(profile) || RESERVED.has(profile))
			problems.push(`nombre de perfil inválido: ${profile}`);
		if (!isRecord(chains)) {
			problems.push(`${profile}: no es un objeto de roles`);
			continue;
		}
		for (const [role, steps] of Object.entries(chains)) {
			if (role !== "*" && !AGENT_NAME.test(role)) problems.push(`${profile}/${role}: nombre de rol inválido`);
			if (!Array.isArray(steps)) {
				problems.push(`${profile}/${role}: no es un arreglo`);
				continue;
			}
			if (steps.length > MAX_CHAIN_LENGTH)
				problems.push(`${profile}/${role}: ${steps.length} pasos > ${MAX_CHAIN_LENGTH}`);
			const models = steps.map((s) => s?.model);
			if (new Set(models).size !== models.length) problems.push(`${profile}/${role}: modelos repetidos`);
			for (const step of steps) {
				if (!isRecord(step)) {
					problems.push(`${profile}/${role}: el paso no es un objeto`);
					continue;
				}
				const stepKeys = Object.keys(step).sort().join(",");
				if (stepKeys !== "model" && stepKeys !== "model,thinking")
					problems.push(`${profile}/${role}: claves de paso ${stepKeys}`);
				if (typeof step.model !== "string" || !SAFE_MODEL_ID.test(step.model))
					problems.push(`${profile}/${role}: id de modelo inválido ${step.model}`);
				if (step.thinking !== undefined && !THINKING_LEVELS.has(step.thinking))
					problems.push(`${profile}/${role}: thinking inválido ${step.thinking}`);
			}
		}
	}
	return problems;
}

function readStore(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function selftest() {
	const doc = {
		kind: KIND,
		version: 1,
		profiles: {
			p: {
				"*": [{ model: "nan/qwen3.8-flash" }, { model: "nan/deepseek-v4-flash", thinking: "low" }],
				orchestrator: [{ model: "nan/glm5.3-flash", thinking: "high" }],
			},
		},
	};
	const out = extendChains(doc);
	const star = out.profiles.p["*"];
	const assert = (ok, msg) => {
		if (!ok) throw new Error(`selftest: ${msg}`);
	};
	assert(star[0].model === "nan/deepseek-v4-flash", "conserva el paso nan vivo primero");
	assert(!star.some((s) => s.model === "nan/qwen3.8-flash"), "descarta el id muerto");
	assert(star.length === 1 + NVIDIA_LADDER.length, "agrega la escalera completa");
	assert(extendChains(out).profiles.p["*"].length === star.length, "es idempotente");
	assert(validate(out).length === 0, "el resultado valida");
	assert(validate({ ...out, version: 2 }).length > 0, "detecta una versión inválida");
	// A file the store rejects is dropped wholesale, so these must be caught here.
	const badThinking = structuredClone(out);
	badThinking.profiles.p["*"][0].thinking = "turbo";
	assert(
		validate(badThinking).some((p) => p.includes("thinking")),
		"detecta un thinking fuera del enum",
	);
	const badProfile = { ...out, profiles: { ...out.profiles, "bad name!": {} } };
	assert(
		validate(badProfile).some((p) => p.includes("perfil")),
		"detecta un nombre de perfil inválido",
	);
	const badRole = { ...out, profiles: { ...out.profiles, p: { ...out.profiles.p, "a b": [] } } };
	assert(
		validate(badRole).some((p) => p.includes("rol")),
		"detecta un nombre de rol inválido",
	);
	// And an id the store accepts must not be reported as invalid.
	const oddId = structuredClone(out);
	oddId.profiles.p["*"][0] = { model: "openrouter/x:free" };
	assert(validate(oddId).length === 0, "acepta un id legal que el store permite");
	console.log("selftest OK: transformación, idempotencia y validación");
}

function main(argv) {
	if (argv.includes("--selftest")) {
		selftest();
		return 0;
	}
	const dryRun = argv.includes("--dry-run");
	const checkOnly = argv.includes("--check");
	let failures = 0;
	let touched = 0;
	for (const home of CONFIG_HOMES) {
		const file = join(home, "profile-fallbacks.json");
		if (!existsSync(file)) continue;
		const doc = readStore(file);
		const before = validate(doc);
		const next = extendChains(doc);
		const after = validate(next);
		const added = Object.values(next.profiles)
			.flatMap((c) => Object.values(c))
			.filter((s) => s.some((x) => x.model.startsWith("nvidia/"))).length;
		console.log(`\n${file}`);
		console.log(
			`  antes: ${before.length ? before.join("; ") : "válido"} | después: ${after.length ? after.join("; ") : "válido"}`,
		);
		console.log(`  cadenas con escalera NVIDIA: ${added}`);
		if (after.length) {
			failures += after.length;
			continue;
		}
		if (checkOnly || dryRun) {
			console.log(`  ${checkOnly ? "solo chequeo" : "dry-run"}: no se escribió nada`);
			continue;
		}
		copyFileSync(file, `${file}.bak-${new Date().toISOString().slice(0, 10)}-nvidia-fallback`);
		writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
		console.log(`  escrito (backup: ${file}.bak-${new Date().toISOString().slice(0, 10)}-nvidia-fallback)`);
		touched++;
	}
	if (failures) {
		console.error(`\n${failures} problema(s) de validación: no se escribió nada`);
		return 1;
	}
	if (!dryRun && !checkOnly)
		console.log(`\nlisto: ${touched} archivo(s) actualizados. Reiniciá el engine para que tome las cadenas.`);
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));

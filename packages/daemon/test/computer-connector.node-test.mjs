import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Public manager/render contracts only. No store, SDK, filesystem, native helper or transport runs.
const forbidden = (names) =>
	names
		.split(" ")
		.map((n) => `export const ${n}=()=>{throw Error('Collaborator must remain inert: ${n}');};`)
		.join("\n");
const modules = new Map([
	["@gentle-dot/protocol", "export const MAX_CONNECTOR_DRAFTS=20;"],
	["./child-guard.ts", forbidden("childGuardFile childGuardText")],
	["./connector-credentials.ts", forbidden("resolveRecord resolveValue storedSignIn")],
	["./connector-import.ts", forbidden("scanClientConfigs valueNotes")],
	[
		"./connector-integrity.ts",
		'export const INTEGRITY_KEY_ID="test";' +
			forbidden("macMatches newIntegrityKey parseIntegrityKey recordMac"),
	],
	["./connector-oauth.ts", "export class SignInCancelledError extends Error {};" + forbidden("startSignIn")],
	["./engine-access.ts", "export const directAccess={};"],
	[
		"./extensions/approval-guard.ts",
		'export const POLICY_ENV="TEST_POLICY";' + forbidden("draftSecretProblem"),
	],
	["./private-file.ts", forbidden("writePrivateFile")],
	["./runtime.ts", forbidden("runtimeDir runtimeModules")],
	["./secret-source.ts", 'export const NO_APP="test"; export class SecretsUnavailableError extends Error {}'],
	[
		"node:fs",
		forbidden(
			"chmodSync existsSync lstatSync mkdirSync readdirSync readFileSync renameSync rmdirSync unlinkSync watch writeFileSync",
		),
	],
]);
registerHooks({
	resolve(specifier, context, next) {
		if (context.parentURL?.endsWith("/connectors.ts") && modules.has(specifier))
			return {
				url: "data:text/javascript," + encodeURIComponent(modules.get(specifier)),
				shortCircuit: true,
			};
		return next(specifier, context);
	},
});
const { ConnectorManager, renderMcpJson } = await import("../src/connectors.ts");

function harness() {
	let endpoint;
	const logs = [],
		changes = [];
	const store = {
		state: () => ({ connectors: {} }),
		computerUrl: () => endpoint?.url,
		setComputer: (next) => {
			if (endpoint === next) return false;
			endpoint = next;
			return true;
		},
	};
	const manager = new ConnectorManager({ store, log: (line) => logs.push(line) });
	manager.onChanged = (restart) => changes.push(restart);
	return { manager, logs, changes };
}
const endpoint = { url: "http://127.0.0.1:1234/mcp", token: "TEST_ONLY_PRIVATE_SENTINEL" };

test("Computer metadata is platform-neutral and distinguishes registration from consent", () => {
	const { manager, logs } = harness();
	assert.equal(
		manager.list().some((info) => info.id === "computer"),
		false,
	);
	manager.registerComputer({}, endpoint);
	const info = manager.list().find((info) => info.id === "computer");
	assert.equal(info.status, "connected"); // transport registration contract, not a grant
	assert.match(info.sends, /registered helper/i);
	assert.match(info.sends, /session you allow/i);
	assert.doesNotMatch(JSON.stringify(info), /this Mac|TEST_ONLY_PRIVATE_SENTINEL|127\.0\.0\.1/);
	assert.doesNotMatch(logs.join("\n"), /TEST_ONLY_PRIVATE_SENTINEL|127\.0\.0\.1/);
});

test("registration ownership, restart signal, image warning and private MCP transport stay intact", () => {
	const { manager, changes } = harness();
	const owner = {},
		stranger = {};
	manager.registerComputer(owner, endpoint);
	manager.imagesSupported = () => false;
	assert.equal(manager.list().find((info) => info.id === "computer").noImages, true);
	manager.imagesSupported = () => true;
	assert.equal(manager.list().find((info) => info.id === "computer").noImages, undefined);
	manager.unregisterComputer(stranger);
	assert.equal(
		manager.list().some((info) => info.id === "computer"),
		true,
	);
	manager.unregisterComputer(owner);
	assert.equal(
		manager.list().some((info) => info.id === "computer"),
		false,
	);
	assert.deepEqual(changes, [true, true]);
	const config = JSON.parse(renderMcpJson({ connectors: {} }, endpoint)).mcpServers.computer;
	assert.deepEqual(config, {
		url: endpoint.url,
		headers: { Authorization: `Bearer ${endpoint.token}` },
		exposure: "direct",
		timeout: 300,
	});
	assert.deepEqual(JSON.parse(renderMcpJson({ connectors: {} })), { mcpServers: {} });
});

/**
 * The values the daemon's MCP proxy adds to a connector's real server (S25.4). For now they come
 * from where they lived before the proxy: the values the user typed (kept in `connectors.json`) and
 * the OAuth sign-ins in pi-mcp's state format (`mcp-auth.json`, now in the daemon's own sign-in
 * home). T23d moves them to the Keychain.
 */
import { execFileSync } from "node:child_process";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import {
	authorizeMcp,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthStateStore,
	parseWwwAuthenticate,
} from "@earendil-works/pi-mcp/oauth";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Where a refresh says it would redirect when nothing is stored; refreshing never redirects. */
const FALLBACK_REDIRECT = "http://127.0.0.1/callback";

/**
 * A value in the engine's syntax, resolved the way the engine resolved it before the proxy: a
 * leading `!` runs the rest as a command and takes its output, `$NAME` and `${NAME}` read the
 * environment, `$$` is `$` and `$!` is `!`. Throws when a variable or the command gives nothing.
 */
export function resolveValue(text: string, env: NodeJS.ProcessEnv, label: string): string {
	if (text.startsWith("!")) {
		let output = "";
		try {
			output = execFileSync("/bin/sh", ["-c", text.slice(1)], {
				encoding: "utf8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
				env,
			}).trim();
		} catch {}
		if (!output) throw new Error(`${label} could not be read: its command gave nothing.`);
		return output;
	}
	let resolved = "";
	for (let index = 0; index < text.length; ) {
		const dollar = text.indexOf("$", index);
		if (dollar < 0) {
			resolved += text.slice(index);
			break;
		}
		resolved += text.slice(index, dollar);
		const next = text[dollar + 1];
		if (next === "$" || next === "!") {
			resolved += next;
			index = dollar + 2;
			continue;
		}
		const braced = next === "{" ? /^\$\{([^}]*)\}/.exec(text.slice(dollar)) : undefined;
		const name = braced ? braced[1] : /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(dollar))?.[1];
		if (!name || !ENV_NAME.test(name)) {
			resolved += braced ? braced[0] : "$";
			index = dollar + (braced ? braced[0].length : 1);
			continue;
		}
		const value = env[name];
		if (!value) throw new Error(`${label} needs the environment variable ${name}.`);
		resolved += value;
		index = dollar + (braced ? braced[0].length : 1 + name.length);
	}
	return resolved;
}

/** Every value of a record resolved with {@link resolveValue}; undefined when there is none. */
export function resolveRecord(
	values: Record<string, string> | undefined,
	env: NodeJS.ProcessEnv,
	label: string,
): Record<string, string> | undefined {
	if (!values || Object.keys(values).length === 0) return undefined;
	return Object.fromEntries(
		Object.entries(values).map(([key, text]) => [key, resolveValue(text, env, `${label} ${key}`)]),
	);
}

export interface OAuthClientSettings {
	clientId?: string;
	clientSecret?: string;
	/** The redirect registered for the user's own OAuth app; a refresh sends it as is. */
	redirectUrl?: string;
}

/**
 * Sends the stored access token and, after a 401, refreshes it with the stored refresh token, like
 * the engine did: concurrent 401s share one refresh, a token another sign-in already replaced is
 * just retried, and when the user must sign in again (no refresh token, a refused refresh, or more
 * scope) it throws `McpOAuthAuthorizationRequiredError`. Never starts a browser sign-in.
 */
export function storedSignIn(
	serverUrl: string,
	store: McpOAuthStateStore,
	settings: () => OAuthClientSettings,
): AuthProvider {
	let refreshing: Promise<void> | undefined;
	return {
		token: async () => (await store.load())?.tokens?.access_token,
		onUnauthorized: async (context) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
			refreshing ??= (async () => {
				const state = await store.load();
				if (state?.tokens?.access_token !== context.token) return;
				if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				const { clientId, clientSecret, redirectUrl } = settings();
				const registered = state.clientInformation;
				const provider = new McpOAuthProvider({
					serverUrl,
					redirectUrl:
						redirectUrl ??
						(registered && "redirect_uris" in registered ? registered.redirect_uris[0] : undefined) ??
						FALLBACK_REDIRECT,
					clientMetadata: { client_name: "Gentle Dot" },
					...(clientId ? { clientId } : {}),
					...(clientSecret ? { clientSecret } : {}),
					store,
					onRedirect: () => {},
				});
				const result = await authorizeMcp(provider, {
					serverUrl,
					fetch: context.fetch,
					...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
					...(challenge.scope ? { scope: challenge.scope } : {}),
				});
				if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
			})().finally(() => {
				refreshing = undefined;
			});
			await refreshing;
		},
	};
}

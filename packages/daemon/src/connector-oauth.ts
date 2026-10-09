/**
 * A connector's OAuth sign-in, run by the daemon itself (S25.5) with pi-mcp's OAuth client, the way
 * the engine's `mcp login` ran it before: a refresh when the stored tokens allow it, otherwise the
 * authorization code flow (PKCE, dynamic client registration or the user's own client) against a
 * loopback callback. The browser comes back to that callback, or the user pastes the address it
 * landed on. The whole flow keeps its state in memory; the caller stores the result once, in the
 * app's secure store, so nothing of it is ever written to a file.
 */
import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import {
	authorizeMcp,
	McpOAuthProvider,
	type McpOAuthState,
	MemoryOAuthStateStore,
	OAuthCallbackServer,
	type OAuthClientInformationMixed,
} from "@earendil-works/pi-mcp/oauth";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
export const CLIENT_NAME = "Gentle Dot";

/** The user's own OAuth client and its fixed redirect, when the connector has one. */
export interface OAuthSettings {
	clientId?: string;
	clientSecret?: string;
	callbackUrl?: string;
	callbackPort?: number;
	scope?: string;
}

export interface SignInOptions {
	serverUrl: string;
	/** The sign-in stored so far (its client registration and tokens), if any. */
	stored?: McpOAuthState;
	settings: OAuthSettings;
	/** The fetch for discovery, registration, and tokens; tests pass a stand-in. */
	fetch?: typeof fetch;
	/** The page the user approves access on; the window that started the sign-in opens it. */
	onAuthorizationUrl(url: URL): void;
}

export interface SignIn {
	/** The new sign-in (with its tokens), when it is done. */
	done: Promise<McpOAuthState>;
	/**
	 * An address the user pasted from the browser's address bar; false when it is not this sign-in's
	 * loopback address with its `state` (the sign-in keeps waiting).
	 */
	paste(text: string): boolean;
	cancel(): void;
}

export class SignInCancelledError extends Error {
	constructor() {
		super("Sign-in cancelled");
		this.name = "SignInCancelledError";
	}
}

function callbackSettings(settings: OAuthSettings) {
	const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`);
	const address = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port ? Number(url.port) : settings.callbackPort;
	let fixedRedirectUrl: string | undefined;
	// A configured address with a port is sent exactly as written: servers compare it as a string.
	if (url.port) fixedRedirectUrl = settings.callbackUrl;
	else if (port !== undefined) {
		url.port = String(port);
		fixedRedirectUrl = url.href;
	}
	return {
		// `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
		host: address === "localhost" ? CALLBACK_HOST : address,
		redirectHost: address,
		port,
		path: url.pathname,
		fixedRedirectUrl,
	};
}

const registeredRedirects = (client: OAuthClientInformationMixed | undefined) =>
	client && "redirect_uris" in client ? client.redirect_uris : [];

/** Listens on `port`, or on a free one when it is taken and not `required`. */
async function listen(
	callback: ReturnType<typeof callbackSettings>,
	port: number | undefined,
	required: boolean,
) {
	const options = {
		host: callback.host,
		redirectHost: callback.redirectHost,
		path: callback.path,
		renderPage: (page: { ok: true } | { ok: false; message: string; details?: string }) =>
			page.ok
				? oauthSuccessHtml("Signed in. You can close this page and go back to Gentle Dot.")
				: oauthErrorHtml(page.message, page.details),
	};
	try {
		return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 });
	} catch (error) {
		if (required || port === undefined) throw error;
		return OAuthCallbackServer.listen(options);
	}
}

/** Starts a sign-in; `done` settles when it finished, failed, or was cancelled. */
export function startSignIn(options: SignInOptions): SignIn {
	let expected: { redirect: URL; state: string } | undefined;
	let fromUser: ((response: { code: string; iss?: string }) => void) | undefined;
	let cancelled: (() => void) | undefined;
	let isCancelled = false;
	const pasted = new Promise<{ code: string; iss?: string }>((resolve) => {
		fromUser = resolve;
	});
	const stopped = new Promise<never>((_resolve, reject) => {
		cancelled = () => reject(new SignInCancelledError());
	});
	stopped.catch(() => {});

	const done = (async () => {
		const { serverUrl, stored, settings } = options;
		const callbackOptions = callbackSettings(settings);
		// The port of the registered redirect, so the registered client stays valid.
		const registered = registeredRedirects(stored?.clientInformation)[0];
		const preferredPort =
			callbackOptions.port ?? (registered ? Number(new URL(registered).port) || undefined : undefined);
		const callback = await listen(callbackOptions, preferredPort, callbackOptions.port !== undefined);
		try {
			if (isCancelled) throw new SignInCancelledError();
			const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl;
			const store = new MemoryOAuthStateStore();
			if (stored) {
				const next: McpOAuthState = { ...stored };
				// Every sign-in gets a fresh `state`.
				delete next.oauthState;
				// A registered client cannot use another redirect, and its tokens belong to it.
				const keepClient =
					settings.clientId || registeredRedirects(stored.clientInformation).includes(redirectUrl);
				if (!keepClient) {
					delete next.clientInformation;
					delete next.tokens;
					delete next.tokensExpireAt;
				}
				store.save(next);
			}
			let authorizationUrl: URL | undefined;
			const provider = new McpOAuthProvider({
				serverUrl,
				redirectUrl,
				clientMetadata: { client_name: CLIENT_NAME },
				...(settings.clientId ? { clientId: settings.clientId } : {}),
				...(settings.clientSecret ? { clientSecret: settings.clientSecret } : {}),
				store,
				onRedirect: (url) => {
					authorizationUrl = url;
				},
			});
			const flow = {
				serverUrl,
				...(settings.scope ? { scope: settings.scope } : {}),
				...(options.fetch ? { fetch: options.fetch } : {}),
			};
			// A stored refresh token signs in again without the browser.
			if ((await Promise.race([authorizeMcp(provider, flow), stopped])) === "AUTHORIZED")
				return finished(store);
			if (!authorizationUrl) throw new Error("The sign-in did not produce an address to approve.");
			const state = await provider.state();
			const redirect = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? redirectUrl);
			expected = { redirect, state };
			const fromBrowser = callback.waitForCallback(state, redirect.pathname);
			fromBrowser.catch(() => {});
			options.onAuthorizationUrl(authorizationUrl);
			const { code, iss } = await Promise.race([fromBrowser, pasted, stopped]);
			await Promise.race([
				authorizeMcp(provider, { ...flow, authorizationCode: code, ...(iss ? { iss } : {}) }),
				stopped,
			]);
			return finished(store);
		} finally {
			expected = undefined;
			await callback.close().catch(() => {});
		}
	})();

	return {
		done,
		paste(text) {
			const want = expected;
			const url = URL.canParse(text.trim()) ? new URL(text.trim()) : undefined;
			const loopback = url && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
			const code = url?.searchParams.get("code");
			if (
				!want ||
				!url ||
				!loopback ||
				url.protocol !== "http:" ||
				url.port !== want.redirect.port ||
				url.pathname !== want.redirect.pathname ||
				url.searchParams.get("state") !== want.state ||
				!code
			)
				return false;
			const iss = url.searchParams.get("iss");
			fromUser?.({ code, ...(iss ? { iss } : {}) });
			return true;
		},
		cancel() {
			isCancelled = true;
			cancelled?.();
		},
	};
}

function finished(store: MemoryOAuthStateStore): McpOAuthState {
	const state = store.load();
	if (!state?.tokens?.access_token) throw new Error("The sign-in finished without a token.");
	return state;
}

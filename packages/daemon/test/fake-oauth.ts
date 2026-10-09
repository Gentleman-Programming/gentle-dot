// A stand-in for an MCP server's OAuth authorization server (protected resource metadata,
// authorization server metadata, dynamic client registration, the token endpoint) behind a `fetch`
// the daemon is given, and for the user's browser: `browse(url)` approves an authorization URL the
// way the provider would, by calling its loopback `redirect_uri` with a code and the `state`.

const ISSUER = "https://auth.example.com";

export interface FakeOAuthOptions {
	/** "fail": the token endpoint refuses every code. */
	mode?: "ok" | "fail";
}

export function fakeOAuth(options: FakeOAuthOptions = {}) {
	let issued = 0;
	const codes = new Map<string, string>();
	const refreshTokens = new Set<string>();
	const tokenRequests: { grant: string; clientId?: string; clientSecret?: string }[] = [];
	const registered: { redirect_uris: string[] }[] = [];

	const json = (status: number, body: unknown) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

	const tokens = () => {
		issued++;
		const refresh = `refresh-token-${issued}`;
		refreshTokens.add(refresh);
		return {
			access_token: `access-token-${issued}`,
			token_type: "Bearer",
			expires_in: 3600,
			refresh_token: refresh,
		};
	};

	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
			const resource = `${url.origin}${url.pathname.slice("/.well-known/oauth-protected-resource".length) || "/"}`;
			return json(200, { resource, authorization_servers: [ISSUER] });
		}
		if (url.origin !== ISSUER) return new Response("not found", { status: 404 });
		if (url.pathname === "/.well-known/oauth-authorization-server")
			return json(200, {
				issuer: ISSUER,
				authorization_endpoint: `${ISSUER}/authorize`,
				token_endpoint: `${ISSUER}/token`,
				registration_endpoint: `${ISSUER}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
			});
		if (url.pathname === "/register" && method === "POST") {
			const body = JSON.parse(String(init?.body ?? "{}")) as { redirect_uris: string[] };
			registered.push(body);
			return json(201, { ...body, client_id: `registered-client-${registered.length}` });
		}
		if (url.pathname === "/token" && method === "POST") {
			const form = new URLSearchParams(String(init?.body ?? ""));
			const grant = form.get("grant_type") ?? "";
			const basic = new Headers(init?.headers).get("authorization");
			const [basicId, basicSecret] = basic?.startsWith("Basic ")
				? decodeURIComponent(atob(basic.slice(6))).split(":")
				: [];
			const clientId = form.get("client_id") ?? basicId;
			const clientSecret = form.get("client_secret") ?? basicSecret;
			tokenRequests.push({
				grant,
				...(clientId ? { clientId } : {}),
				...(clientSecret ? { clientSecret } : {}),
			});
			if (options.mode === "fail") return json(400, { error: "invalid_grant" });
			if (grant === "authorization_code") {
				const code = form.get("code") ?? "";
				if (!codes.has(code)) return json(400, { error: "invalid_grant" });
				codes.delete(code);
				return json(200, tokens());
			}
			if (grant === "refresh_token") {
				const refresh = form.get("refresh_token") ?? "";
				if (!refreshTokens.delete(refresh)) return json(400, { error: "invalid_grant" });
				return json(200, tokens());
			}
			return json(400, { error: "unsupported_grant_type" });
		}
		return new Response("not found", { status: 404 });
	};

	/** What the user's browser does after they approve: the provider redirects to the loopback address. */
	const callbackFor = (authorization: string) => {
		const url = new URL(authorization);
		const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
		const code = `authorization-code-${codes.size + issued + 1}`;
		codes.set(code, url.searchParams.get("code_challenge") ?? "");
		redirect.searchParams.set("code", code);
		redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
		if (redirect.hostname === "localhost") redirect.hostname = "127.0.0.1";
		return redirect;
	};

	return {
		fetch,
		/** The redirect the provider would send the browser to; nothing is opened. */
		callbackFor,
		/** The browser follows the provider's redirect to this computer's sign-in page. */
		browse: async (authorization: string | URL) => {
			const response = await globalThis.fetch(callbackFor(String(authorization)));
			await response.text();
			return response.status;
		},
		tokenRequests,
		registered,
		/** The access token the provider issued last. */
		lastAccessToken: () => `access-token-${issued}`,
		issued: () => issued,
	};
}

/** The daemon's `connectorOAuth` with a stand-in provider; `auto`: the user approves as soon as the page opens. */
export function oauthOptions(auto = false, oauth = fakeOAuth()) {
	return {
		fetch: oauth.fetch,
		...(auto ? { openBrowser: (url: string) => void oauth.browse(url).catch(() => {}) } : {}),
	};
}

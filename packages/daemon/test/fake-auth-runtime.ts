import type { AuthRuntime } from "../src/auth.ts";

type Interaction = Parameters<AuthRuntime["login"]>[2];

/** A stand-in for Pi's ModelRuntime: three providers and scripted sign-in flows. */
export function fakeAuthRuntime() {
	const configured = new Set<string>();
	const state = { aborted: false, logins: [] as string[] };
	const runtime: AuthRuntime = {
		getProviders: () => [
			{
				id: "anthropic",
				name: "Anthropic",
				auth: { apiKey: { name: "API key" }, oauth: { name: "Claude Pro/Max" } },
			},
			{ id: "openai", name: "OpenAI", auth: { apiKey: { name: "API key" } } },
			{ id: "github-copilot", name: "GitHub Copilot", auth: { oauth: { name: "GitHub Copilot" } } },
			{ id: "local", name: "Local", auth: {} },
		],
		getProviderAuthStatus: (id) =>
			configured.has(id) ? { configured: true, source: "stored" } : { configured: false },
		async login(id, type, interaction: Interaction) {
			state.logins.push(`${id}:${type}`);
			interaction.signal?.addEventListener("abort", () => {
				state.aborted = true;
			});
			if (type === "oauth") {
				interaction.notify({
					type: "auth_url",
					url: "https://example.com/authorize?x=1",
					instructions: "Sign in",
				});
				interaction.notify({ type: "progress", message: "Waiting for the browser…" });
				const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
				if (code !== "good-code")
					throw new Error("token exchange failed: invalid_grant (raw provider detail)");
			} else {
				const key = await interaction.prompt({ type: "secret", message: "Enter your API key" });
				if (!key.startsWith("sk-")) throw new Error("bad key");
			}
			configured.add(id);
			return { type: type === "oauth" ? "oauth" : "api_key" };
		},
		async logout(id) {
			configured.delete(id);
		},
	};
	return { runtime, configured, state };
}

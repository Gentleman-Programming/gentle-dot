import type { AuthProvider } from "@gentle-dot/protocol";

/** Search provider labels without changing provider data or order. */
export function searchProviders(providers: AuthProvider[] | undefined, filter: string): AuthProvider[] {
	const query = filter.trim().toLowerCase();
	return (providers ?? []).filter(
		(provider) =>
			provider.name.toLowerCase().includes(query) ||
			(provider.oauthName?.toLowerCase().includes(query) ?? false),
	);
}

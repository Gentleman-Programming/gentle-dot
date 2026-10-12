import { useState } from "react";

/**
 * The page opened without a token in the URL and without one in storage (a phone, or an installed
 * PWA, which keeps its own storage on iOS). Paste the access key the daemon prints, and the app
 * connects; the key lands in the same storages a URL token would (see `saveToken`).
 */
export function AccessKeyForm({ onSubmit }: { onSubmit: (token: string) => void }) {
	const [token, setToken] = useState("");
	const ready = token.trim().length > 0;
	return (
		<form
			className="access-key-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (ready) onSubmit(token.trim());
			}}
		>
			<label htmlFor="access-key">Access key</label>
			<input
				id="access-key"
				value={token}
				onChange={(event) => setToken(event.target.value)}
				placeholder="Paste the access key"
				autoComplete="off"
				autoCorrect="off"
				spellCheck={false}
			/>
			<button type="submit" disabled={!ready}>
				Connect
			</button>
		</form>
	);
}

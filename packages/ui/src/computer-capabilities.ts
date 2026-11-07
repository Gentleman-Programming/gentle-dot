/** Presentation only: a user agent never establishes native support or consent. */
export type ComputerPlatform = "mac" | "windows" | "unknown";

export function computerPlatform(userAgent: string): ComputerPlatform {
	if (/Windows NT/i.test(userAgent)) return "windows";
	if (/Macintosh|Mac OS X/i.test(userAgent) && !/iPhone|iPad|iPod/i.test(userAgent)) return "mac";
	return "unknown";
}

/** Requestable macOS permissions; screenshot support is a capability, not a permission. */
export const computerPermissionKinds = ["accessibility", "screenRecording"] as const;

export function registeredComputerEndpoint(value: unknown): value is { url: string; token: string } {
	if (typeof value !== "object" || value === null) return false;
	const endpoint = value as Record<string, unknown>;
	return (
		typeof endpoint.url === "string" &&
		endpoint.url.trim().length > 0 &&
		typeof endpoint.token === "string" &&
		endpoint.token.trim().length > 0
	);
}

/** Observe registration only. Cleanup rejects a stale native result after disconnect/unmount. */
export function observeComputerRegistration(
	enabled: boolean,
	connected: boolean,
	endpoint: () => Promise<unknown>,
	update: (registered: boolean) => void,
): () => void {
	let live = true;
	update(false);
	if (enabled && connected) {
		endpoint().then(
			(value) => {
				if (live) update(registeredComputerEndpoint(value));
			},
			() => {
				if (live) update(false);
			},
		);
	}
	return () => {
		live = false;
	};
}

/** Current prerequisites only. This result NEVER grants a session or Yolo mode. */
export function computerReadiness(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const probe = value as Record<string, unknown>;
	return (
		probe.accessibility === true && probe.screenRecording === true && probe.screenshotsSupported === true
	);
}

export function computerCopy(platform: ComputerPlatform) {
	switch (platform) {
		case "mac":
			return {
				banner: "Controlling your Mac",
				panic: "⌥⇧Esc",
				prerequisites:
					"Current permissions and screenshot support are not a session grant. The app asks you to allow a session separately.",
				limits: "Stop ends the session and drops queued actions.",
			};
		case "windows":
			return {
				banner: "Controlling your Windows PC",
				panic: "Alt+Shift+Esc",
				prerequisites:
					"Current native prerequisites are not a session grant or a promise that the next action will succeed. The app asks you to allow a session separately. No permission can be granted here.",
				limits:
					"Only verified running apps can be brought forward; cold launch and cross-app drag are unsupported. Stop drops queued actions; an already-inserted input batch may finish.",
			};
		default:
			return {
				banner: "Controlling your computer",
				panic: "the native emergency shortcut",
				prerequisites:
					"Platform-specific guidance is unavailable. Helper registration and current prerequisites are not a session grant.",
				limits: "Use Stop to end the session. Native support must be established by the desktop app.",
			};
	}
}

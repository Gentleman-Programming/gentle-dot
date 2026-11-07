import { vi } from "vitest";

// Daemon admission uses an owned account registry in tests, never the host account home.
// Production keeps OS account metadata and has no test environment override.
vi.mock("../src/daemon-admission.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/daemon-admission.ts")>();
	const { tempDir } = await import("./helpers.ts");
	const account = tempDir();
	return {
		...actual,
		claimDaemonAdmission: (options: Parameters<typeof actual.claimDaemonAdmission>[0]) =>
			actual.claimDaemonAdmission({ ...options, accountHome: options.accountHome ?? (() => account) }),
	};
});

import { defineConfig, devices } from "@playwright/test";

const PORT = 4391;

export default defineConfig({
	testDir: "e2e",
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	reporter: [["list"]],
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		command: "pnpm build && node e2e/serve.ts",
		url: `http://127.0.0.1:${PORT}/health`,
		env: { GENTLE_DOT_PORT: String(PORT) },
		reuseExistingServer: false,
		timeout: 60_000,
	},
});

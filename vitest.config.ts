import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "node",
					include: [
						"packages/protocol/test/**/*.test.ts",
						"packages/daemon/test/**/*.test.ts",
						"scripts/package/test/**/*.test.ts",
						"scripts/package/test-linux/**/*.test.ts",
					],
					environment: "node",
					testTimeout: 20_000,
				},
			},
			"packages/ui",
		],
	},
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	base: "./",
	build: { outDir: "dist/app", emptyOutDir: true },
	test: {
		name: "ui",
		environment: "jsdom",
		include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
	},
});

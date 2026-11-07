import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	base: "./",
	build: {
		outDir: "dist/app",
		emptyOutDir: true,
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{
							name: "react-vendor",
							test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
						},
					],
				},
			},
		},
	},
	test: {
		name: "ui",
		environment: "jsdom",
		include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
	},
});

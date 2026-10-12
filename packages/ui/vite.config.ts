import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

// The PWA pieces only matter for the served build; the test run skips the plugin entirely.
const plugins = [react()];
if (!process.env.VITEST) {
	plugins.push(
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: ["favicon.svg", "favicon.png"],
			manifest: {
				name: "Gentle Dot",
				short_name: "Gentle Dot",
				description: "Your assistant, always one key away — the Gentle Dot web client.",
				theme_color: "#1a1218",
				background_color: "#1a1218",
				display: "standalone",
				start_url: ".",
				icons: [
					{ src: "icon-192.png", sizes: "192x192", type: "image/png" },
					{ src: "icon-512.png", sizes: "512x512", type: "image/png" },
					{
						src: "icon-maskable-512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "maskable",
					},
				],
			},
			// The daemon serves hashed assets with a far-future cache and a no-store index;
			// precaching the shell keeps the app opening offline, and there is nothing to
			// runtime-cache: everything else flows over the WebSocket.
			workbox: { globPatterns: ["**/*.{js,css,html,svg,png,woff2}"] },
		}),
	);
}

export default defineConfig({
	plugins,
	base: "./",
	build: { outDir: "dist/app", emptyOutDir: true },
	test: {
		name: "ui",
		environment: "jsdom",
		include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
	},
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Evaluate only our literal config; imports are stubbed, not a Vite/build test.
function config() {
	const source = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8")
		.replace(/^import .*;\r?\n/gm, "")
		.replace("export default", "return");
	return Function(
		"react",
		"defineConfig",
		source,
	)(
		() => ({ name: "react-test" }),
		(value) => value,
	);
}
test("React core gets its own vendor group without absorbing app or Markdown modules", () => {
	const value = config();
	const groups = value.build.rolldownOptions?.output?.codeSplitting?.groups;
	assert.equal(groups?.length, 1, "one focused React dependency group");
	const group = groups[0];
	assert.equal(group.name, "react-vendor");
	for (const path of [
		"/repo/node_modules/react/index.js",
		"/repo/node_modules/react/jsx-runtime.js",
		"/repo/node_modules/react-dom/client.js",
		"/repo/node_modules/scheduler/index.js",
		"/repo/node_modules/.pnpm/react@19.3.0/node_modules/react/index.js",
		"C:\\repo\\node_modules\\.pnpm\\react-dom@19.3.0\\node_modules\\react-dom\\client.js",
	])
		assert.equal(group.test.test(path), true, path);
	for (const path of [
		"/repo/packages/ui/src/App.tsx",
		"/repo/node_modules/react-markdown/index.js",
		"/repo/node_modules/remark-gfm/index.js",
		"/repo/node_modules/@tauri-apps/api/core.js",
	])
		assert.equal(group.test.test(path), false, path);
	assert.equal(value.build.chunkSizeWarningLimit, undefined, "do not conceal oversized chunks");
	assert.equal(value.build.outDir, "dist/app");
	assert.equal(value.build.emptyOutDir, true);
	assert.equal(value.base, "./");
	assert.equal(value.test.environment, "jsdom");
	assert.deepEqual(value.test.include, ["test/**/*.test.tsx", "test/**/*.test.ts"]);
});

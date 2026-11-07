import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TAURI = join(REPO, "apps", "desktop", "src-tauri");

/** The shape W8 configures, so a missing key is a type error rather than a passing test. */
interface WindowsBundle {
	bundle: {
		targets: string[];
		publisher: string;
		longDescription: string;
		icon: string[];
		resources?: Record<string, string>;
		windows: {
			nsis: { installMode: string };
			wix: { upgradeCode: string };
			webviewInstallMode: { type: string };
		};
	};
}

/** Only the shared config's icon list is read here; the rest belongs to macOS and Linux. */
interface SharedBundle {
	bundle: { icon: string[] };
}

function read<T>(name: string): T {
	return JSON.parse(readFileSync(join(TAURI, name), "utf8")) as T;
}

/**
 * W8's bundle decisions, pinned so a later edit has to be deliberate. The bundle itself is
 * verified by building it and inspecting its payload (L34/L35); these are the choices a rebuild
 * would otherwise change in silence.
 */
describe("tauri.windows.conf.json", () => {
	const windows = read<WindowsBundle>("tauri.windows.conf.json");

	it("bundles an NSIS and an MSI installer, and names the publisher", () => {
		expect(windows.bundle.targets).toEqual(["nsis", "msi"]);
		expect(windows.bundle.publisher).toBe("Gentleman Programming");
	});

	it("installs per user, so installing needs no administrator", () => {
		expect(windows.bundle.windows.nsis.installMode).toBe("currentUser");
	});

	it("carries the Windows icon here, never in the shared config", () => {
		// tauri-build needs icons/icon.ico for the Windows Resource file (L18), and the shared
		// config is what macOS and Linux also bundle from, which this host cannot test.
		expect(windows.bundle.icon).toEqual(["icons/icon.ico"]);
		expect(existsSync(join(TAURI, "icons", "icon.ico"))).toBe(true);
		const shared = read<SharedBundle>("tauri.conf.json").bundle.icon;
		expect(shared.some((icon) => icon.endsWith(".ico"))).toBe(false);
	});

	it("states how WebView2 is installed rather than inheriting a default", () => {
		expect(windows.bundle.windows.webviewInstallMode.type).toBe("downloadBootstrapper");
	});

	it("pins the MSI upgrade code, so the product identity cannot drift", () => {
		expect(windows.bundle.windows.wix.upgradeCode).toMatch(
			/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/,
		);
	});

	it("does not promise a runtime the Windows bundle does not carry yet", () => {
		// `bundle.resources` is injected at release time by scripts/package/lib.mjs's
		// `tauriReleaseConfig`, and the Windows packaging script is W11's work. Until then the
		// installer payload is the app exe and its uninstaller, so the description has to say less
		// than the Linux one does: an installer that claims a bundled engine and ships none is
		// worse than a shorter description.
		const claimsRuntime = /carries its own/i.test(windows.bundle.longDescription);
		expect(claimsRuntime && !windows.bundle.resources).toBe(false);
	});
});

describe("the Windows build needs no cargo configuration", () => {
	it("adds no Windows entry to .cargo/config.toml", () => {
		// A measured negative (L34): the release build and the bundler run without one. An [env]
		// block for this host's SDK paths would hardcode one developer machine's layout.
		const toml = readFileSync(join(TAURI, ".cargo", "config.toml"), "utf8").toLowerCase();
		expect(toml).not.toContain("windows");
	});
});

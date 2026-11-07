import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

// Inert API-shaped fixtures only: no SDK/provider initialization, credentials, engine or profile.
const fixture = vi.hoisted(() => ({
	create: vi.fn(),
	settings: vi.fn(),
	jiti: vi.fn(),
	load: vi.fn(),
	deviceId: vi.fn(),
	register: vi.fn(),
	login: vi.fn(),
	logout: vi.fn(),
	check: vi.fn(),
	auth: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
	ModelRuntime: { create: fixture.create },
	SettingsManager: { create: fixture.settings },
}));
vi.mock("jiti", () => ({ createJiti: fixture.jiti }));

import { createModelAuthRuntime } from "../src/auth.ts";

beforeEach(() => {
	vi.clearAllMocks();
	fixture.create.mockResolvedValue({
		registerNativeProvider: fixture.register,
		getProviders: () => [{ id: "synthetic", name: "Synthetic", auth: { apiKey: { name: "Fixture key" } } }],
		getProviderAuthStatus: () => ({ configured: false }),
		login: fixture.login,
		logout: fixture.logout,
		checkAuth: fixture.check,
		getAuth: fixture.auth,
	});
	fixture.settings.mockReturnValue({ getOrCreateDeviceId: fixture.deviceId });
	fixture.deviceId.mockReturnValue("synthetic-device-id");
	fixture.jiti.mockReturnValue({ import: fixture.load });
	fixture.load.mockResolvedValue({ createNanProviderConfig: () => ({ id: "synthetic-extension" }) });
	fixture.check.mockResolvedValue(undefined);
	fixture.auth.mockResolvedValue({ auth: { apiKey: "synthetic-not-a-credential" } });
});

it("binds SDK 1.4 API boundaries to the explicit assistant home with model networking disabled", async () => {
	const home = mkdtempSync(join(tmpdir(), "auth-api-fixture-"));
	const runtime = await createModelAuthRuntime(home, home);
	expect(fixture.create).toHaveBeenCalledWith({
		authPath: join(home, "auth.json"),
		modelsPath: join(home, "models.json"),
		allowModelNetwork: false,
	});
	expect(fixture.settings).toHaveBeenCalledWith(home, home);
	expect(fixture.jiti).toHaveBeenCalledWith(expect.any(String), { fsCache: false });
	expect(fixture.load).toHaveBeenCalledWith("gentle-pi/lib/nan-provider.ts");
	expect(fixture.register).toHaveBeenCalledWith({ id: "synthetic-extension" });
	expect(runtime.getProviders()[0]?.id).toBe("synthetic");
	expect(runtime.getProviderAuthStatus("synthetic")).toEqual({ configured: false });
	const interaction = { prompt: async () => "synthetic", notify: () => {} };
	await runtime.login("synthetic", "api_key", interaction);
	const [id, type, passed, options] = fixture.login.mock.calls[0]!;
	expect([id, type, passed]).toEqual(["synthetic", "api_key", interaction]);
	expect(fixture.deviceId).not.toHaveBeenCalled();
	expect(options.getDeviceId()).toBe("synthetic-device-id");
	await runtime.logout("synthetic");
	expect(fixture.logout).toHaveBeenCalledWith("synthetic");
});

it("never resolves OAuth auth for voice; resolves only an API-key-authenticated OpenAI fixture", async () => {
	const home = mkdtempSync(join(tmpdir(), "auth-api-fixture-"));
	const runtime = await createModelAuthRuntime(home, home);
	for (const status of [undefined, { type: "oauth" }]) {
		fixture.check.mockResolvedValue(status);
		expect(await runtime.openAIApiKey?.()).toBeUndefined();
	}
	expect(fixture.auth).not.toHaveBeenCalled();
	fixture.check.mockResolvedValue({ type: "api_key" });
	expect(await runtime.openAIApiKey?.()).toBe("synthetic-not-a-credential");
	expect(fixture.auth).toHaveBeenCalledWith("openai");
	fixture.auth.mockResolvedValue(undefined);
	expect(await runtime.openAIApiKey?.()).toBeUndefined();
});

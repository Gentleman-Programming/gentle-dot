import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { VoiceDevicesSettings } from "../src/components/VoiceDevicesSettings.tsx";
import { LocaleProvider, useLocale } from "../src/i18n.tsx";
import { initialState } from "../src/store.ts";
import { useVoice } from "../src/useVoice.ts";
import * as voiceRuntime from "../src/voice-device-runtime.ts";
import { createVoiceDeviceRuntime } from "../src/voice-device-runtime.ts";
import { createVoiceDevices } from "../src/voice-devices.ts";

vi.mock("../src/desktop.ts", () => ({ inDesktop: () => false }));

function fixture() {
	const media = vi.fn();
	const devices = createVoiceDevices({
		storage: localStorage,
		secureContext: true,
		media: { getUserMedia: media, enumerateDevices: async () => [] },
	});
	const runtime = createVoiceDeviceRuntime({
		devices,
		nativeDevices: async () => ({ supported: false, devices: [] }),
		startNative: vi.fn(),
		getUserMedia: media,
	});
	runtime.setRoute({ kind: "daemon" });
	return { runtime, media };
}
function SwitchLocale() {
	const { setLocale } = useLocale();
	return (
		<button type="button" onClick={() => setLocale("es")}>
			Español
		</button>
	);
}
beforeEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});

it("refreshes catalog revisions without replacing subscriptions on locale changes and retires stale results", async () => {
	const { runtime, media } = fixture();
	type Catalog = Awaited<ReturnType<typeof runtime.catalog>>;
	const catalogValue: Catalog = {
		browser: { status: "ok", devices: [] },
		native: { supported: false, devices: [] },
		nativeError: false,
	};
	let oldResult!: (value: Catalog) => void;
	const catalog = vi
		.spyOn(runtime, "catalog")
		.mockImplementationOnce(
			() =>
				new Promise<Catalog>((resolve) => {
					oldResult = resolve;
				}),
		)
		.mockResolvedValue(catalogValue);
	const offRoute = vi.fn();
	const subscribe = vi.spyOn(runtime, "subscribe").mockReturnValue(offRoute);
	const originalSubscribe = runtime.devices.subscribe;
	const offPreferences = vi.fn();
	const preferences = vi.spyOn(runtime.devices, "subscribe").mockImplementation((listener) => {
		const off = originalSubscribe(listener);
		return () => {
			offPreferences();
			off();
		};
	});
	const view = render(
		<LocaleProvider>
			<SwitchLocale />
			<VoiceDevicesSettings runtime={runtime} />
		</LocaleProvider>,
	);
	await waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
	fireEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
	await waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
	fireEvent.click(screen.getByRole("button", { name: "Español" }));
	expect(subscribe).toHaveBeenCalledTimes(1);
	expect(preferences).toHaveBeenCalledTimes(1);
	expect(catalog).toHaveBeenCalledTimes(2);
	act(() => {
		runtime.devices.set("browserInput", "exact-device-id");
	});
	await waitFor(() => expect(catalog).toHaveBeenCalledTimes(3));
	expect(screen.getByRole("combobox", { name: "Entrada de voz" })).toHaveValue("exact-device-id");
	await act(async () => oldResult({ ...catalogValue, browser: { status: "error", devices: [] } }));
	expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	view.unmount();
	expect(offRoute).toHaveBeenCalledTimes(1);
	expect(offPreferences).toHaveBeenCalledTimes(1);
	expect(media).not.toHaveBeenCalled();
});

it("keeps voice callbacks and check registration stable across state rerenders", () => {
	const { runtime, media } = fixture();
	vi.spyOn(voiceRuntime, "voiceDeviceRuntime").mockReturnValue(runtime);
	const register = vi.spyOn(runtime, "registerChecks");
	const send = vi.fn();
	const { result, rerender, unmount } = renderHook(({ state }) => useVoice(state, send), {
		initialProps: { state: initialState },
	});
	const first = result.current;
	rerender({ state: { ...initialState, messages: [...initialState.messages] } });
	for (const name of ["start", "stop", "cancel", "stopSpeaking"] as const)
		expect(result.current[name]).toBe(first[name]);
	expect(register).toHaveBeenCalledTimes(1);
	unmount();
	expect(media).not.toHaveBeenCalled();
	expect(send).not.toHaveBeenCalled();
});

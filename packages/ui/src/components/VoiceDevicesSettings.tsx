import { useEffect, useState } from "react";
import { useLocale } from "../i18n.tsx";
import type { voiceEn } from "../i18n-voice-messages.ts";
import { type VoiceDeviceRuntime, voiceDeviceRuntime } from "../voice-device-runtime.ts";
import type { DeviceSlot } from "../voice-devices.ts";
import { VoiceChecks } from "./VoiceChecks.tsx";

/** Metadata only on mount. Recording and test audio are never started here. */
export function VoiceDevicesSettings({ runtime = voiceDeviceRuntime() }: { runtime?: VoiceDeviceRuntime }) {
	const { t } = useLocale();
	const [revision, refresh] = useState(0);
	const [catalog, setCatalog] = useState<Awaited<ReturnType<VoiceDeviceRuntime["catalog"]>>>();
	const [pending, setPending] = useState(false);
	const [note, setNote] = useState<keyof typeof voiceEn | "">("");
	useEffect(() => {
		const offRoute = runtime.subscribe(() => refresh((n) => n + 1));
		const offPreferences = runtime.devices.subscribe(() => refresh((n) => n + 1));
		return () => {
			offRoute();
			offPreferences();
		};
	}, [runtime]);
	useEffect(() => {
		// A revision invalidates metadata even when the runtime identity is unchanged.
		void revision;
		let live = true;
		void runtime.catalog().then((value) => {
			if (live) setCatalog(value);
		});
		return () => {
			live = false;
		};
	}, [runtime, revision]);
	const saved = runtime.devices.read();
	const route = runtime.route();
	const slot = route.kind === "daemon" ? "browserInput" : "nativeInput";
	const inactiveSlot = slot === "nativeInput" ? "browserInput" : "nativeInput";
	const caps = runtime.devices.capabilities();
	const inputSupported =
		route.kind === "daemon" ? caps.enumerate : route.kind === "native" && catalog?.native.supported === true;
	const inputs =
		route.kind === "daemon"
			? (catalog?.browser.devices
					.filter((d) => d.kind === "audioinput")
					.map((d) => ({ id: d.deviceId, label: d.label })) ?? [])
			: (catalog?.native.devices ?? []);
	const outputs =
		catalog?.browser.devices
			.filter((d) => d.kind === "audiooutput")
			.map((d) => ({ id: d.deviceId, label: d.label })) ?? [];
	function save(slot: DeviceSlot, id: string) {
		const result = runtime.devices.set(slot, id || null);
		setNote(result.status === "ok" ? "voice.saved" : "voice.saveFailed");
	}
	function selector(
		label: string,
		slot: DeviceSlot,
		devices: Array<{ id: string; label: string }>,
		supported: boolean,
	) {
		const id = saved.preferences[slot];
		const found = devices.some((d) => d.id === id);
		const status = !catalog
			? t("voice.loading")
			: !supported
				? t("voice.unsupported")
				: id && !found
					? t("voice.missing")
					: id
						? t("voice.listed")
						: t("voice.defaultStatus");
		return (
			<>
				<label className="shortcut-row">
					<span>{label}</span>
					<select
						aria-label={label}
						value={id ?? ""}
						disabled={saved.status !== "ok"}
						onChange={(e) => save(slot, e.target.value)}
					>
						<option value="">{t("voice.default")}</option>
						{id && (!found || !supported) ? (
							<option value={id}>{t(!supported ? "voice.savedUnsupported" : "voice.savedMissing")}</option>
						) : null}
						{supported
							? devices.map((device, index) => (
									<option key={device.id} value={device.id}>
										{device.label || `${t("voice.unlabelled")} ${index + 1}`}
									</option>
								))
							: null}
					</select>
				</label>
				<p className="muted" role="status">
					{status}
				</p>
			</>
		);
	}
	return (
		<section className="provider-section" aria-labelledby="settings-voice-devices">
			<h3 id="settings-voice-devices">{t("voice.devices")}</h3>
			<p className="muted">
				{t("voice.inputRoute")}{" "}
				{t(
					route.kind === "daemon"
						? "voice.browserDaemon"
						: route.kind === "native"
							? "voice.nativeRecognizer"
							: "voice.unavailable",
				)}
				{"."} {t("voice.routeHelp")}
			</p>
			{selector(t("voice.input"), slot, inputs, inputSupported)}
			{saved.preferences[inactiveSlot] ? (
				<p className="muted">
					{t(inactiveSlot === "nativeInput" ? "voice.inactiveNative" : "voice.inactiveBrowser")}{" "}
					<button type="button" onClick={() => save(inactiveSlot, "")}>
						{t("voice.clearInactive")}
					</button>
				</p>
			) : null}
			{selector(t("voice.output"), "browserOutput", outputs, caps.output)}
			<p className="muted">{t("voice.outputHelp")}</p>
			{catalog?.nativeError || catalog?.browser.status === "error" ? (
				<p className="settings-error" role="alert">
					{t("voice.catalogFailed")}
				</p>
			) : null}
			{saved.status !== "ok" ? (
				<p className="settings-error" role="alert">
					{t("voice.readFailed")}{" "}
					<button
						type="button"
						onClick={() => {
							const result = runtime.devices.reset();
							refresh((n) => n + 1);
							setNote(result.status === "ok" ? "voice.cleared" : "voice.clearFailed");
						}}
					>
						{t("voice.clear")}
					</button>
				</p>
			) : null}
			<div className="shortcut-row">
				<button type="button" onClick={() => refresh((n) => n + 1)}>
					{t("voice.refresh")}
				</button>
				<button
					type="button"
					disabled={!caps.permission || pending}
					onClick={async () => {
						setPending(true);
						const result = await runtime.devices.requestPermission();
						setPending(false);
						setNote(result.status === "ok" ? "voice.permissionGranted" : "voice.permissionFailed");
						refresh((n) => n + 1);
					}}
				>
					{t("voice.permission")}
				</button>
			</div>
			{note ? <p role="status">{t(note)}</p> : null}
			<VoiceChecks runtime={runtime} />
		</section>
	);
}

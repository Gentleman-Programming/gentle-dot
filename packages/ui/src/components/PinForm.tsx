import { type ClientMessage, type ConnectorInfo, PIN_PATTERN, type PinStatus } from "@gentle-dot/protocol";
import { type ReactNode, useState } from "react";
import { useLocale } from "../i18n.tsx";
import { controlEn } from "../i18n-control-messages.ts";

interface PinFormProps {
	pin: PinStatus;
	/** The submit button's label. */
	action: string;
	/** A valid PIN; `created` when the user just chose it (send `pin_set` first). */
	onPin: (pin: string, created: boolean) => void;
	/** Buttons shown next to the submit button. */
	children?: ReactNode;
}

/**
 * The web PIN on a server (S25.8): a new one is chosen and repeated on first use, then typed before
 * each connector change or allowed action. It goes to the daemon only; the assistant never sees it.
 */
export function PinForm({ pin, action, onPin, children }: PinFormProps) {
	const { t } = useLocale();
	const [value, setValue] = useState("");
	const [repeat, setRepeat] = useState("");
	const [problem, setProblem] = useState<string>();
	const field = (label: string, text: string, set: (v: string) => void) => (
		<input
			aria-label={label}
			type="password"
			inputMode="numeric"
			autoComplete="off"
			placeholder={label}
			value={text}
			onChange={(event) => {
				setProblem(undefined);
				set(event.target.value);
			}}
		/>
	);
	return (
		<form
			className="ask-form pin-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (!PIN_PATTERN.test(value)) return setProblem(t("pinFormat"));
				if (!pin.set && repeat !== value) return setProblem(t("pinMismatch"));
				onPin(value, !pin.set);
				setValue("");
				setRepeat("");
			}}
		>
			{pin.set ? null : <p className="connector-note">{t("pinHelp")}</p>}
			{pin.locked ? <p className="connector-note">{t("pinLocked")}</p> : null}
			{pin.set ? field(t("pinLabel"), value, setValue) : field(t("pinNew"), value, setValue)}
			{pin.set ? null : field(t("pinRepeat"), repeat, setRepeat)}
			{problem ? <p role="alert">{problem}</p> : null}
			<button type="submit" className="primary">
				{action}
			</button>
			{children}
		</form>
	);
}

/** What a connector change confirmed with the PIN will do, in the user's words. */
export function describePinCommand(
	message: ClientMessage,
	connectors: ConnectorInfo[] = [],
	t: (key: keyof typeof controlEn) => string = (key) => controlEn[key],
): string {
	// Insert supplied names last, so their contents are never interpreted as template tokens.
	const named = (key: keyof typeof controlEn, id: string) =>
		t(key).replace("{name}", () => connectors.find((c) => c.id === id)?.name ?? id);
	switch (message.type) {
		case "connector_mode":
			return t("pinMode")
				.replace("{mode}", () => t(message.mode === "read_write" ? "pinReadWrite" : "pinReadOnly"))
				.replace(
					"{name}",
					() => connectors.find((c) => c.id === message.connectorId)?.name ?? message.connectorId,
				);
		case "connector_connect":
		case "connector_signin":
		case "connector_setup":
			return named("pinConnect", message.connectorId);
		case "connector_disconnect":
			return named("pinDisconnect", message.connectorId);
		case "connector_remove":
			return named("pinRemove", message.connectorId);
		case "connector_draft_reply":
			return t("pinDraft");
		case "connector_import":
			return t(message.ids.length === 1 ? "pinImportOne" : "pinImportMany").replace("{count}", () =>
				String(message.ids.length),
			);
		default:
			return t("pinChange");
	}
}

/** Renderer-only display provenance; never part of a wire or persisted message. */
export type StatusDisplay =
	| { kind: "stopped" }
	| { kind: "offline" }
	| { kind: "connectorImported"; names: string[] }
	| { kind: "hideFailed"; reason: string }
	| { kind: "pinCancelled" };

export const statusEn = {
	statusStopped: "Stopped.",
	statusOffline: "Not connected yet. Try again in a moment.",
	statusImported: "Imported {names}. Their tools stay hidden until you choose Read and send.",
	statusNothingImported: "Nothing was imported.",
	statusPinCancelled: "Nothing was changed.",
} as const;

export const statusEs: Record<keyof typeof statusEn, string> = {
	statusStopped: "Detenido.",
	statusOffline: "Aún no hay conexión. Inténtalo de nuevo en un momento.",
	statusImported:
		"Se importaron {names}. Sus herramientas permanecerán ocultas hasta que elijas Leer y enviar.",
	statusNothingImported: "No se importó nada.",
	statusPinCancelled: "No se cambió nada.",
};

/** Translate only annotated producers, not raw text or note kinds from history. */
export function statusMessage(
	raw: string,
	display: StatusDisplay | undefined,
	t: (key: keyof typeof statusEn | "chatHideFailed") => string,
): string {
	switch (display?.kind) {
		case "stopped":
			return t("statusStopped");
		case "offline":
			return t("statusOffline");
		case "connectorImported":
			return display.names.length
				? t("statusImported").replace("{names}", () => display.names.join(", "))
				: t("statusNothingImported");
		case "hideFailed":
			return `${t("chatHideFailed")} ${display.reason}`;
		case "pinCancelled":
			return t("statusPinCancelled");
		default:
			return raw;
	}
}

import { accountEn, accountEs } from "./i18n-account-messages.ts";
import { attachmentEn, attachmentEs } from "./i18n-attachment-messages.ts";
import { chatEn, chatEs } from "./i18n-chat-messages.ts";
import { computerEn, computerEs } from "./i18n-computer-messages.ts";
import { connectorEn, connectorEs } from "./i18n-connector-messages.ts";
import { controlEn, controlEs } from "./i18n-control-messages.ts";
import { messageListEn, messageListEs } from "./i18n-message-list-messages.ts";
import { profileEn, profileEs } from "./i18n-profile-messages.ts";
import { settingsEn, settingsEs } from "./i18n-settings-messages.ts";
import { statusEn, statusEs } from "./i18n-status-messages.ts";
import { voiceEn, voiceEs } from "./i18n-voice-messages.ts";

export type UiLocale = "en" | "es";

// Each feature owns its bilingual display text; the composed keys stay type-safe.
const en = {
	...chatEn,
	...accountEn,
	...messageListEn,
	...controlEn,
	...profileEn,
	...settingsEn,
	...connectorEn,
	...computerEn,
	...voiceEn,
	...attachmentEn,
	...statusEn,
	// Preserve the original alias; the entrypoint also needs the target's server route.
	chatMissingTokenWithServer:
		"This page needs your access key. On your computer, open it from the Gentle Dot menu (Open in browser); on a server, open the link with #token=<your access key>.",
	settings: "Settings",
	closeSettings: "Close settings",
	interfaceLanguage: "Interface language",
} as const;

export type MessageKey = keyof typeof en;

export const messages: Record<UiLocale, Record<MessageKey, string>> = {
	en,
	es: {
		...chatEs,
		...accountEs,
		...messageListEs,
		...controlEs,
		...profileEs,
		...settingsEs,
		...connectorEs,
		...computerEs,
		...voiceEs,
		...attachmentEs,
		...statusEs,
		chatMissingTokenWithServer:
			"Esta página necesita tu clave de acceso. En tu ordenador, ábrela desde el menú de Gentle Dot (Abrir en el navegador); en un servidor, abre el enlace con #token=<tu clave de acceso>.",
		settings: "Ajustes",
		closeSettings: "Cerrar ajustes",
		interfaceLanguage: "Idioma de la interfaz",
	},
};

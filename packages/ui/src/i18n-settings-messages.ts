// Settings-body display messages; the existing locale-selector keys stay composed.
export const settingsEn = {
	"settings.shortcut": "Keyboard shortcut",
	"settings.shortcutHelp": "Opens and hides the panel from any app.",
	"settings.shortcutLoadFailed": "Gentle Dot could not read the current shortcut.",
	"settings.recording": "Press the new shortcut… Esc cancels.",
	"settings.cancel": "Cancel",
	"settings.change": "Change",
	"settings.applying": "Applying {shortcut}…",
	"settings.saved": "Saved. It works right away.",
	"settings.shortcutFailed": "Gentle Dot could not change the shortcut.",
	"settings.shortcutHint": "Use at least one modifier key ({modifiers}), or a function key.",
	"settings.default": "Default: {shortcut}",
	"settings.reset": "Reset to default",
	"settings.memory": "Memory",
	"settings.memoryHelp":
		"Turn this on to give the assistant a memory of its own instead of yours: it starts empty and never reads or writes your Engram.",
	"settings.memoryLoadFailed": "Gentle Dot could not read the memory setting.",
	"settings.privateMemory": "Private memory",
	"settings.memoryFailed": "Gentle Dot could not change the memory setting.",
	"settings.voiceLanguage": "Voice language",
	"settings.voiceLanguageHelp":
		"The language macOS speech listens in. The local voice model detects it by itself.",
	"settings.automaticLanguage": "Automatic (system language)",
} as const;

export const settingsEs: Record<keyof typeof settingsEn, string> = {
	"settings.shortcut": "Atajo de teclado",
	"settings.shortcutHelp": "Abre y oculta el panel desde cualquier aplicación.",
	"settings.shortcutLoadFailed": "Gentle Dot no pudo leer el atajo actual.",
	"settings.recording": "Pulsa el nuevo atajo… Esc cancela.",
	"settings.cancel": "Cancelar",
	"settings.change": "Cambiar",
	"settings.applying": "Aplicando {shortcut}…",
	"settings.saved": "Guardado. Funciona de inmediato.",
	"settings.shortcutFailed": "Gentle Dot no pudo cambiar el atajo.",
	"settings.shortcutHint": "Usa al menos una tecla modificadora ({modifiers}) o una tecla de función.",
	"settings.default": "Predeterminado: {shortcut}",
	"settings.reset": "Restablecer predeterminado",
	"settings.memory": "Memoria",
	"settings.memoryHelp":
		"Activa esta opción para darle al asistente una memoria propia en lugar de la tuya: empieza vacía y nunca lee ni escribe en tu Engram.",
	"settings.memoryLoadFailed": "Gentle Dot no pudo leer la configuración de memoria.",
	"settings.privateMemory": "Memoria privada",
	"settings.memoryFailed": "Gentle Dot no pudo cambiar la configuración de memoria.",
	"settings.voiceLanguage": "Idioma de voz",
	"settings.voiceLanguageHelp":
		"El idioma que escucha el reconocimiento de voz de macOS. El modelo de voz local lo detecta por sí solo.",
	"settings.automaticLanguage": "Automático (idioma del sistema)",
};

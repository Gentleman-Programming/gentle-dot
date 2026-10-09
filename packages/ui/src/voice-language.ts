/**
 * The language macOS speech listens in (S30.6). Apple's recognizer does not detect the language
 * by itself, so a Mac set to English heard Spanish as noise; the local model (Parakeet) detects
 * it and ignores this. Kept in this window's storage; empty means the system language.
 */
const KEY = "gentle-dot-voice-language";

export const VOICE_LANGUAGES: readonly (readonly [locale: string, label: string])[] = [
	["", "Automatic (system language)"],
	["es-ES", "Español"],
	["en-US", "English"],
	["pt-BR", "Português"],
	["fr-FR", "Français"],
	["de-DE", "Deutsch"],
	["it-IT", "Italiano"],
];

/** The chosen locale, or undefined for the system language. */
export function voiceLanguage(): string | undefined {
	try {
		const locale = localStorage.getItem(KEY);
		return locale && VOICE_LANGUAGES.some(([value]) => value === locale) ? locale : undefined;
	} catch {
		return undefined;
	}
}

export function setVoiceLanguage(locale: string): void {
	try {
		if (locale) localStorage.setItem(KEY, locale);
		else localStorage.removeItem(KEY);
	} catch {
		// Private browsing: the choice lasts for this window only.
	}
}

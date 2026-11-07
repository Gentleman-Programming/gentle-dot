import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { type MessageKey, messages, type UiLocale } from "./i18n-messages.ts";

export const UI_LANGUAGE_KEY = "gentle-dot-ui-language";

function localeOrEnglish(value: unknown): UiLocale {
	return value === "es" ? "es" : "en";
}

function storedLocale(): UiLocale {
	try {
		return localeOrEnglish(window.localStorage.getItem(UI_LANGUAGE_KEY));
	} catch {
		return "en";
	}
}

function translate(locale: UiLocale, key: MessageKey): string {
	return messages[locale][key];
}

const LocaleContext = createContext({
	locale: "en" as UiLocale,
	setLocale: (_locale: UiLocale) => {},
	t: (key: MessageKey) => translate("en", key),
});

/** UI preference only: never sent to the daemon or used as a speech locale. */
export function LocaleProvider({ children }: { children: ReactNode }) {
	const [locale, updateLocale] = useState(storedLocale);
	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.key !== UI_LANGUAGE_KEY && event.key !== null) return;
			try {
				if (event.storageArea && event.storageArea !== window.localStorage) return;
			} catch {
				// Storage can be unavailable while mounted; the event still has the new value.
			}
			updateLocale(localeOrEnglish(event.newValue));
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	const setLocale = (next: UiLocale) => {
		const selected = localeOrEnglish(next);
		updateLocale(selected);
		try {
			window.localStorage.setItem(UI_LANGUAGE_KEY, selected);
		} catch {
			// The mounted interface still works when persistence is denied.
		}
	};

	return (
		<LocaleContext.Provider value={{ locale, setLocale, t: (key: MessageKey) => translate(locale, key) }}>
			{children}
		</LocaleContext.Provider>
	);
}

export function useLocale() {
	return useContext(LocaleContext);
}

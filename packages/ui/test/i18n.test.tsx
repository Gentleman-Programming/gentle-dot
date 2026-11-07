import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider, UI_LANGUAGE_KEY, useLocale } from "../src/i18n.tsx";
import { chatEn, chatEs } from "../src/i18n-chat-messages.ts";
import { messages } from "../src/i18n-messages.ts";

function Labels() {
	const { locale, setLocale, t } = useLocale();
	return (
		<>
			<h2>{t("settings")}</h2>
			<output aria-label="Locale">{locale}</output>
			<button type="button" onClick={() => setLocale("es")}>
				Español
			</button>
		</>
	);
}

function mount() {
	return render(
		<LocaleProvider>
			<Labels />
		</LocaleProvider>,
	);
}

beforeEach(() => localStorage.removeItem(UI_LANGUAGE_KEY));
afterEach(() => {
	vi.restoreAllMocks();
	localStorage.removeItem(UI_LANGUAGE_KEY);
});

function storage(key: string | null, newValue: string | null, storageArea = localStorage) {
	act(() => {
		window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea }));
	});
}

describe("UI locale (F2a)", () => {
	it("retains the original missing-token alias while exposing target server guidance separately", () => {
		expect(messages.en.chatMissingToken).toBe(chatEn.chatMissingToken);
		expect(messages.es.chatMissingToken).toBe(chatEs.chatMissingToken);
		for (const locale of ["en", "es"] as const)
			expect(messages[locale].chatMissingTokenWithServer).toContain("#token=<");
	});

	it("defaults to English even outside a provider", () => {
		render(<Labels />);
		expect(screen.getByRole("heading")).toHaveTextContent("Settings");
		expect(screen.getByLabelText("Locale")).toHaveTextContent("en");
	});

	it("persists a choice and restores it when the provider remounts", () => {
		const first = mount();
		expect(screen.getByRole("heading")).toHaveTextContent("Settings");
		fireEvent.click(screen.getByRole("button", { name: "Español" }));
		expect(screen.getByRole("heading")).toHaveTextContent("Ajustes");
		expect(localStorage.getItem(UI_LANGUAGE_KEY)).toBe("es");
		first.unmount();
		mount();
		expect(screen.getByRole("heading")).toHaveTextContent("Ajustes");
		expect(screen.getByLabelText("Locale")).toHaveTextContent("es");
	});

	it.each(["invalid", "es-ES", "", "null"])("falls back for stored %j", (value) => {
		localStorage.setItem(UI_LANGUAGE_KEY, value);
		mount();
		expect(screen.getByRole("heading")).toHaveTextContent("Settings");
	});

	it("updates mounted labels for other windows, removals and clear without echo writes", () => {
		mount();
		const write = vi.spyOn(Storage.prototype, "setItem");
		storage("gentle-dot-voice-language", "es-ES");
		expect(screen.getByRole("heading")).toHaveTextContent("Settings");
		storage(UI_LANGUAGE_KEY, "es", sessionStorage);
		expect(screen.getByRole("heading")).toHaveTextContent("Settings");
		storage(UI_LANGUAGE_KEY, "es");
		expect(screen.getByRole("heading")).toHaveTextContent("Ajustes");
		storage(UI_LANGUAGE_KEY, "invalid");
		expect(screen.getByRole("heading")).toHaveTextContent("Settings");
		storage(UI_LANGUAGE_KEY, "es");
		storage(UI_LANGUAGE_KEY, null);
		expect(screen.getByRole("heading")).toHaveTextContent("Settings");
		storage(UI_LANGUAGE_KEY, "es");
		storage(null, null);
		expect(screen.getByRole("heading")).toHaveTextContent("Settings");
		expect(write).not.toHaveBeenCalled();
	});

	it("works in memory if accessing localStorage is denied", () => {
		vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
			throw new DOMException("Denied", "SecurityError");
		});
		mount();
		expect(screen.getByRole("heading")).toHaveTextContent("Settings");
		fireEvent.click(screen.getByRole("button", { name: "Español" }));
		expect(screen.getByRole("heading")).toHaveTextContent("Ajustes");
	});

	it("keeps the mounted choice if saving fails", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("Full", "QuotaExceededError");
		});
		const first = mount();
		fireEvent.click(screen.getByRole("button", { name: "Español" }));
		expect(screen.getByRole("heading")).toHaveTextContent("Ajustes");
		first.unmount();
		mount();
		expect(screen.getByRole("heading")).toHaveTextContent("Settings");
	});
});

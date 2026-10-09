import { invoke } from "@tauri-apps/api/core";

/** The shortcut that opens the panel, as the desktop app reports it (S33). */
export interface ShortcutInfo {
	shortcut: string;
	default: string;
}

export function loadShortcut(): Promise<ShortcutInfo> {
	return invoke<ShortcutInfo>("shortcut_get");
}

/** Binds and saves a new shortcut; resolves with its saved spelling or rejects with the app's reason. */
export async function saveShortcut(shortcut: string): Promise<string> {
	const result = await invoke<{ shortcut: string }>("shortcut_set", { shortcut });
	return result.shortcut;
}

export function isMac(userAgent: string = navigator.userAgent): boolean {
	return /Mac|iPhone|iPad/.test(userAgent);
}

type Modifier = "Ctrl" | "Alt" | "Shift" | "Super";

/** The macOS order of modifiers (⌃⌥⇧⌘), also used for the accelerator the app saves. */
const MODIFIERS: { name: Modifier; symbol: string }[] = [
	{ name: "Ctrl", symbol: "⌃" },
	{ name: "Alt", symbol: "⌥" },
	{ name: "Shift", symbol: "⇧" },
	{ name: "Super", symbol: "⌘" },
];

/** Every spelling the app's accelerator parser accepts for a modifier. */
function modifierOf(token: string, mac: boolean): Modifier | undefined {
	switch (token.toLowerCase()) {
		case "ctrl":
		case "control":
			return "Ctrl";
		case "alt":
		case "option":
			return "Alt";
		case "shift":
			return "Shift";
		case "super":
		case "cmd":
		case "command":
			return "Super";
		case "cmdorctrl":
		case "cmdorcontrol":
		case "commandorctrl":
		case "commandorcontrol":
			return mac ? "Super" : "Ctrl";
		default:
			return undefined;
	}
}

function keyLabel(key: string): string {
	const short = /^(?:Key|Digit)(.)$/.exec(key)?.[1];
	if (short) return short;
	if (/^esc(ape)?$/i.test(key)) return "Esc";
	return key.length === 1 ? key.toUpperCase() : key;
}

/** An accelerator as the user reads it: macOS symbols on macOS (⌥ Space), names elsewhere (Alt+Space). */
export function formatShortcut(accelerator: string, mac: boolean): string {
	const tokens = accelerator
		.split("+")
		.map((t) => t.trim())
		.filter(Boolean);
	const held = new Set(tokens.map((t) => modifierOf(t, mac)).filter((m) => m !== undefined));
	const key = keyLabel(tokens.find((t) => modifierOf(t, mac) === undefined) ?? "");
	const modifiers = MODIFIERS.filter((m) => held.has(m.name));
	if (!mac) return [...modifiers.map((m) => m.name), key].join("+");
	const symbols = modifiers.map((m) => m.symbol).join("");
	return symbols && key.length > 1 ? `${symbols} ${key}` : `${symbols}${key}`;
}

export type Recorded = { kind: "shortcut"; accelerator: string } | { kind: "waiting" } | { kind: "cancel" };

type KeyPress = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const MODIFIER_KEY = /^(?:Shift|Control|Alt|Meta|OS|CapsLock|Fn)(?:Left|Right)?$/;

/**
 * Turns a keydown into the app's accelerator (`Ctrl+Alt+K`). The key comes from the physical key
 * (`code`), since ⌥ changes the typed character on macOS. Esc alone cancels; modifiers alone wait.
 */
export function recordKey(event: KeyPress): Recorded {
	const code = event.code || event.key;
	if (!code || MODIFIER_KEY.test(code) || MODIFIER_KEY.test(event.key)) return { kind: "waiting" };
	const held: Record<Modifier, boolean> = {
		Ctrl: event.ctrlKey,
		Alt: event.altKey,
		Shift: event.shiftKey,
		Super: event.metaKey,
	};
	const modifiers = MODIFIERS.filter((m) => held[m.name]).map((m) => m.name);
	if (code === "Escape" && modifiers.length === 0) return { kind: "cancel" };
	const key = /^(?:Key|Digit)(.)$/.exec(code)?.[1] ?? code;
	return { kind: "shortcut", accelerator: [...modifiers, key].join("+") };
}

import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY } from "../src/i18n.tsx";
import { activeTitle, type DotAction, type DotState, initialState, reduce } from "../src/store.ts";
import { useDot } from "../src/useDot.ts";

const h = vi.hoisted(() => ({ wire: vi.fn(() => false), start: vi.fn(), stop: vi.fn(), hide: vi.fn() }));
vi.mock("../src/client.ts", async (original) => ({
	...(await original<typeof import("../src/client.ts")>()),
	DotClient: class {
		start = h.start;
		stop = h.stop;
		send = h.wire;
	},
}));
vi.mock("../src/desktop.ts", async (original) => ({
	...(await original<typeof import("../src/desktop.ts")>()),
	inDesktop: () => true,
	connectionInfo: async () => ({ url: "ws://fixture/ws", token: "synthetic" }),
	onDesktopEvent: async () => () => {},
	hidePanel: () => h.hide(),
}));
vi.mock("../src/useComputer.ts", () => ({ useComputerAvailable: () => false, useComputerState: () => ({}) }));
vi.mock("../src/usePanelWindow.ts", () => ({
	usePanelWindow: () => ({
		fullscreenNow: { current: false },
		controls: { roseHidden: false, fullscreen: false, setRoseHidden() {}, setFullscreen() {} },
	}),
}));
vi.mock("../src/useVoice.ts", () => ({
	useVoice: () => ({
		phase: "idle",
		elapsed: 0,
		level: 0,
		partial: "",
		speaking: false,
		muted: false,
		start() {},
		stop() {},
		cancel() {},
		stopSpeaking() {},
		typed() {},
		sent() {},
		draftTaken() {},
		setSendOnStop() {},
	}),
}));
const ready: DotState = {
	...initialState,
	connection: "open",
	agentState: "idle",
	features: { conversations: true },
};
function chat(state: DotState, dismiss = vi.fn(), send = vi.fn()) {
	return (
		<LocaleProvider>
			<ChatSurface variant="web" state={state} send={send} dismiss={dismiss} />
		</LocaleProvider>
	);
}
function language(locale: "en" | "es") {
	act(() => window.dispatchEvent(new StorageEvent("storage", { key: UI_LANGUAGE_KEY, newValue: locale })));
}
beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	window.history.replaceState(null, "", "/");
});

describe("renderer status provenance (T8 / S1–S4)", () => {
	it.each(["en", "es"] as const)("renders authored stops, imports and literal collisions in %s", (locale) => {
		localStorage.setItem(UI_LANGUAGE_KEY, locale);
		let state = reduce(ready, {
			type: "server",
			message: { type: "message_done", seq: 1, messageId: "stopped", text: "Stopped.", stopped: true },
		});
		state = reduce(state, {
			type: "server",
			message: {
				type: "message_done",
				seq: 2,
				messageId: "error",
				text: "New conversation",
				error: "Stopped.",
			},
		});
		const names = ["Nothing was imported.", "", "$& {names}"];
		state = reduce(state, { type: "server", message: { type: "connector_imported", seq: 3, names } });
		state = reduce(state, { type: "server", message: { type: "connector_imported", seq: 4, names: [] } });
		state = reduce(state, {
			type: "server",
			message: { type: "toast", seq: 5, level: "info", message: "Nothing was imported." },
		});
		const snapshot = JSON.stringify(state);
		render(chat(state));
		const notes = document.querySelectorAll(".message-note");
		expect(notes[0]?.textContent).toBe(locale === "es" ? "Detenido." : "Stopped.");
		expect(notes[1]?.textContent).toBe("Stopped.");
		expect(document.querySelector(".message-body")?.textContent).toBe("Stopped.");
		expect(document.querySelector(".notices")?.textContent).toContain(
			locale === "es"
				? `Se importaron ${names.join(", ")}. Sus herramientas permanecerán ocultas hasta que elijas Leer y enviar.`
				: `Imported ${names.join(", ")}. Their tools stay hidden until you choose Read and send.`,
		);
		expect(screen.getAllByText("Nothing was imported.")).toHaveLength(locale === "es" ? 1 : 2);
		if (locale === "es") expect(screen.getByText("No se importó nada.")).toBeInTheDocument();
		expect(state.messages[0]?.note?.text).toBe("Stopped.");
		expect(state.notices[1]?.message).toBe("Nothing was imported.");
		expect(JSON.stringify(state)).toBe(snapshot);
	});

	it("relocalizes existing notices/notes, preserves empty drops and exact dismiss/navigation callbacks", async () => {
		let state = reduce(ready, { type: "server", message: { type: "connector_imported", seq: 1, names: [] } });
		state = reduce(state, {
			type: "server",
			message: { type: "message_done", seq: 2, messageId: "s", text: "", stopped: true },
		});
		const before = state;
		for (const action of [
			{ type: "notice", level: "error", message: "", display: { kind: "offline" } },
			{ type: "server", message: { type: "toast", seq: 3, level: "info", message: "" } },
			{ type: "server", message: { type: "error", seq: 4, code: "offline", message: "" } },
		] as const)
			state = reduce(state, action);
		expect(state).toBe(before);
		const dismiss = vi.fn(),
			send = vi.fn();
		render(chat(state, dismiss, send));
		expect(screen.getByText("Stopped.")).toBeInTheDocument();
		language("es");
		expect(screen.getByText("Detenido.")).toBeInTheDocument();
		expect(screen.getByText("No se importó nada.")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Descartar" }));
		expect(dismiss.mock.calls).toEqual([[state.notices[0]?.id]]);
		await userEvent.click(screen.getByRole("button", { name: "Nueva conversación" }));
		expect(send.mock.calls).toEqual([[{ type: "new_conversation" }]]);
		language("en");
		expect(screen.getByText("Stopped.")).toBeInTheDocument();
	});

	it("keeps supplied titles, history notes, user/assistant strings and empty errors raw", () => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		let state = reduce(ready, {
			type: "server",
			message: {
				type: "history",
				seq: 1,
				messages: [
					{ id: "u", role: "user", text: "Nothing was imported.", activities: [] },
					{ id: "a", role: "assistant", text: "Not connected yet. Try again in a moment.", activities: [] },
				],
			},
		});
		state = {
			...state,
			messages: state.messages.map((m) =>
				m.id === "a" ? { ...m, note: { kind: "stopped", text: "Stopped." } } : m,
			),
		};
		state = reduce(state, {
			type: "server",
			message: { type: "message_done", seq: 2, messageId: "empty", text: "", stopped: true, error: "" },
		});
		const view = render(chat(state));
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Nueva conversación");
		for (const title of ["New conversation", ""]) {
			const titled = {
				...state,
				conversationId: "c",
				conversations: [{ id: "c", title, updatedAt: "2026-01-01" }],
			};
			view.rerender(chat(titled));
			expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
			expect(activeTitle(titled)).toBe(title);
		}
		expect(screen.getByText("Stopped.")).toBeInTheDocument();
		expect(screen.getByText("Nothing was imported.")).toBeInTheDocument();
		expect(screen.getByText("Not connected yet. Try again in a moment.")).toBeInTheDocument();
		expect(document.querySelector(".message-note-error")?.textContent).toBe("");
		expect(state.messages.at(-1)?.note).toEqual({ kind: "error", text: "" });
	});

	it("annotates only locally refused sends, retaining exact wire payload and lifecycle", () => {
		const info = { url: "ws://fixture/ws", token: "synthetic" };
		const hook = renderHook(() => useDot(info));
		const payload = { type: "new_conversation" } as const;
		act(() => {
			expect(hook.result.current.send(payload)).toBe(false);
		});
		const state = hook.result.current.state;
		expect(state.notices[0]?.message).toBe("Not connected yet. Try again in a moment.");
		expect(h.wire.mock.calls).toEqual([[payload]]);
		const view = render(chat(state));
		language("es");
		expect(screen.getByText("Aún no hay conexión. Inténtalo de nuevo en un momento.")).toBeInTheDocument();
		view.rerender(
			chat(
				reduce(state, {
					type: "server",
					message: {
						type: "error",
						seq: 1,
						code: "offline",
						message: "Not connected yet. Try again in a moment.",
					},
				}),
			),
		);
		expect(screen.getByText("Not connected yet. Try again in a moment.")).toBeInTheDocument();
		h.wire.mockReturnValueOnce(true);
		act(() => {
			expect(hook.result.current.send(payload)).toBe(true);
		});
		expect(hook.result.current.state).toBe(state);
		hook.unmount();
		expect(h.start).toHaveBeenCalledOnce();
		expect(h.stop).toHaveBeenCalledOnce();
	});

	it.each(["en", "es"] as const)(
		"keeps busy-switch cancellation and confirmation payloads exact in %s",
		async (locale) => {
			localStorage.setItem(UI_LANGUAGE_KEY, locale);
			const send = vi.fn();
			render(chat({ ...ready, agentState: "working" }, vi.fn(), send));
			const newChat = () =>
				screen.getByRole("button", { name: locale === "es" ? "Nueva conversación" : "New conversation" });
			await userEvent.click(newChat());
			await userEvent.click(screen.getByRole("button", { name: locale === "es" ? "Cancelar" : "Cancel" }));
			expect(send).not.toHaveBeenCalled();
			await userEvent.click(newChat());
			await userEvent.click(
				screen.getByRole("button", { name: locale === "es" ? "Detener y cambiar" : "Stop and switch" }),
			);
			expect(send.mock.calls).toEqual([[{ type: "new_conversation" }]]);
		},
	);

	it("leaves full authored-English collisions raw when delivered by a server or caller", () => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		const raw = "Imported Stopped.. Their tools stay hidden until you choose Read and send.";
		let state = reduce(ready, {
			type: "server",
			message: { type: "toast", seq: 1, level: "info", message: raw },
		});
		state = reduce(state, { type: "notice", level: "warning", message: "Stopped." });
		render(chat(state));
		expect(screen.getByText(raw)).toBeInTheDocument();
		expect(screen.getByText("Stopped.")).toBeInTheDocument();
		expect(state.notices.every((notice) => notice.display === undefined)).toBe(true);
		const streaming = reduce(state, {
			type: "server",
			message: { type: "message_delta", seq: 2, messageId: "s", delta: "Stopped." },
		});
		const closed = reduce(streaming, { type: "connection", status: "closed" });
		expect(closed.messages[0]).toEqual({ ...streaming.messages[0], streaming: false });
		expect(closed.messages[0]?.note).toBeUndefined();
	});

	it.each(["en", "es"] as const)(
		"relocalizes mounted hide wrappers without replaying native work from %s",
		async (locale) => {
			localStorage.setItem(UI_LANGUAGE_KEY, locale);
			window.history.replaceState(null, "", "/?surface=panel");
			h.hide.mockRejectedValueOnce("Nothing was imported. $&");
			render(<App />);
			await userEvent.click(
				await screen.findByRole("button", { name: locale === "es" ? "Ocultar" : "Hide" }),
			);
			expect(
				await screen.findByText(
					locale === "es"
						? "No se pudo ocultar el chat: Nothing was imported. $&"
						: "Could not hide the chat: Nothing was imported. $&",
				),
			).toBeInTheDocument();
			language(locale === "es" ? "en" : "es");
			expect(
				screen.getByText(
					locale === "es"
						? "Could not hide the chat: Nothing was imported. $&"
						: "No se pudo ocultar el chat: Nothing was imported. $&",
				),
			).toBeInTheDocument();
			expect(h.hide).toHaveBeenCalledOnce();
			expect(h.wire).not.toHaveBeenCalled();
		},
	);

	it("retains the handled-Escape hide guard across locale changes", async () => {
		window.history.replaceState(null, "", "/?surface=panel");
		render(<App />);
		await screen.findByRole("button", { name: "Hide" });
		for (const locale of ["es", "en"] as const) {
			language(locale);
			const handledEscape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
			handledEscape.preventDefault();
			act(() => {
				window.dispatchEvent(handledEscape);
			});
		}
		expect(h.hide).not.toHaveBeenCalled();
		expect(h.wire).not.toHaveBeenCalled();
		expect(document.querySelector(".notices")).toBeNull();
	});

	it.each(["", "Could not hide the chat: $& {reason}"])(
		"preserves empty or English-collision native reasons: %j",
		async (reason) => {
			window.history.replaceState(null, "", "/?surface=panel");
			h.hide.mockRejectedValueOnce(reason);
			render(<App />);
			await userEvent.click(await screen.findByRole("button", { name: "Hide" }));
			await screen.findByText(
				(_, element) =>
					element?.tagName === "SPAN" && element.textContent === `Could not hide the chat: ${reason}`,
			);
			language("es");
			expect(document.querySelector(".notice > span")?.textContent).toBe(
				`No se pudo ocultar el chat: ${reason}`,
			);
			language("en");
			expect(document.querySelector(".notice > span")?.textContent).toBe(
				`Could not hide the chat: ${reason}`,
			);
			expect(h.hide).toHaveBeenCalledOnce();
			expect(h.wire).not.toHaveBeenCalled();
		},
	);

	it.each(["en", "es"] as const)(
		"annotates only local PIN cancellation and keeps its exact action in %s",
		async (locale) => {
			localStorage.setItem(UI_LANGUAGE_KEY, locale);
			const send = vi.fn(),
				actions = vi.fn<(action: DotAction) => void>();
			const initial: DotState = {
				...ready,
				pin: { set: true },
				connectors: {
					open: true,
					list: [
						{
							id: "fixture",
							name: "Nothing was changed.",
							reads: "raw reads",
							sends: "raw sends",
							added: true,
							enabled: true,
							mode: "read_only",
							status: "connected",
						},
					],
				},
			};
			let latest = initial;
			function Web() {
				const [state, dispatch] = useReducer(reduce, initial);
				latest = state;
				return (
					<ChatSurface
						variant="web"
						state={state}
						send={send}
						dismiss={vi.fn()}
						dispatch={(action) => {
							actions(action);
							dispatch(action);
						}}
					/>
				);
			}
			render(
				<LocaleProvider>
					<Web />
				</LocaleProvider>,
			);
			await userEvent.click(
				screen.getByRole("radio", { name: locale === "es" ? "Leer y enviar" : "Read and send" }),
			);
			expect(screen.getByRole("dialog")).toBeInTheDocument();
			await userEvent.click(
				within(screen.getByRole("dialog")).getByRole("button", {
					name: locale === "es" ? "Cancelar" : "Cancel",
				}),
			);
			expect(actions.mock.calls).toEqual([
				[
					{
						type: "server",
						message: { type: "error", code: "declined", message: "Nothing was changed.", seq: 0 },
						display: { kind: "pinCancelled" },
					},
				],
			]);
			expect(latest.notices[0]?.message).toBe("Nothing was changed.");
			expect(latest.notices[0]?.level).toBe("error");
			expect(latest.pin).toEqual(initial.pin);
			expect(latest.connectors.list).toBe(initial.connectors.list);
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			const notice = document.querySelector(".notices");
			expect(notice?.textContent).toContain(locale === "es" ? "No se cambió nada." : "Nothing was changed.");
			language(locale === "es" ? "en" : "es");
			expect(notice?.textContent).toContain(locale === "es" ? "Nothing was changed." : "No se cambió nada.");
			expect(actions).toHaveBeenCalledOnce();
			expect(send).not.toHaveBeenCalled();
			expect(h.hide).not.toHaveBeenCalled();
		},
	);

	it.each(["none", "starting", "running"] as const)(
		"retains declined-flow behavior for %s flows, including empty errors",
		(stage) => {
			const flow =
				stage === "none"
					? undefined
					: {
							providerId: "fixture",
							events: [],
							...(stage === "running" ? { flowId: "connector-existing" } : {}),
						};
			const state: DotState = { ...ready, pin: { set: true }, connectors: { open: true, flow } };
			const snapshot = JSON.stringify(state);
			for (const message of ["Nothing was changed.", ""]) {
				const action = {
					type: "server",
					message: { type: "error", code: "declined", message, seq: 0 },
				} as const;
				const remote = reduce(state, action);
				const local = reduce(state, { ...action, display: { kind: "pinCancelled" } });
				expect({ ...local, notices: [] }).toEqual({ ...remote, notices: [] });
				expect(local.connectors.flow).toBe(stage === "starting" ? undefined : flow);
				if (message === "") {
					expect(local.notices).toEqual([]);
					expect(remote.notices).toEqual([]);
				} else {
					expect(local.notices[0]).toEqual({
						id: expect.any(Number),
						level: "error",
						message,
						display: { kind: "pinCancelled" },
					});
					expect(remote.notices[0]).toEqual({ id: expect.any(Number), level: "error", message });
				}
			}
			expect(JSON.stringify(state)).toBe(snapshot);
		},
	);

	it("keeps raw hide-notice creation text while locale changes only its display", () => {
		const reason = "Nothing was changed. $&";
		const raw = `Could not hide the chat: ${reason}`;
		const state = reduce(ready, {
			type: "notice",
			level: "error",
			message: raw,
			display: { kind: "hideFailed", reason },
		});
		const snapshot = JSON.stringify(state);
		const view = render(chat(state));
		language("es");
		expect(screen.getByText(`No se pudo ocultar el chat: ${reason}`)).toBeInTheDocument();
		expect(state.notices[0]?.message).toBe(raw);
		expect(JSON.stringify(state)).toBe(snapshot);
		const backend = reduce(ready, {
			type: "server",
			message: { type: "error", code: "declined", message: "Nothing was changed.", seq: 0 },
		});
		view.rerender(chat(backend));
		expect(screen.getByText("Nothing was changed.")).toBeInTheDocument();
		expect(screen.queryByText("No se cambió nada.")).not.toBeInTheDocument();
	});
});

import type { ClientMessage, UploadedFile } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY } from "../src/i18n.tsx";
import type { Uploader } from "../src/uploads.ts";
import { useAttachments } from "../src/useAttachments.ts";
import type { VoiceControls } from "../src/useVoice.ts";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

function voice(overrides: Partial<VoiceControls> = {}): VoiceControls {
	return {
		mic: { available: true },
		phase: "idle",
		elapsed: 65,
		level: 0.4,
		partial: "",
		speaking: false,
		muted: false,
		sendOnStop: false,
		start: vi.fn(),
		stop: vi.fn(),
		cancel: vi.fn(),
		stopSpeaking: vi.fn(),
		setMuted: vi.fn(),
		typed: vi.fn(),
		setSendOnStop: vi.fn(),
		draftTaken: vi.fn(),
		sent: vi.fn(),
		...overrides,
	};
}

const labels = {
	en: {
		message: "Message",
		send: "Send",
		stop: "Stop",
		attach: "Attach files",
		files: "Files to send",
		remove: "Remove",
		uploading: "Uploading",
		failed: "Not sent",
		busy: "Add to what I'm doing…",
		idle: "Ask me anything…",
		talk: "Talk",
		review: "Stop and review",
		direct: "Stop and send",
		listening: "Listening…",
		option: "Send when I stop",
		cancel: "Cancel recording",
		cancelTitle: "Cancel (Esc)",
		timer: "Recording time",
		meter: "Microphone level",
		status: "Voice",
		transcribing: "Transcribing…",
		tip: "Tap to talk, tap again to review before sending",
		directTip: "Tap to talk, tap again to send",
		failure: "Not connected, so the message was not sent. It is kept here to send again.",
	},
	es: {
		message: "Mensaje",
		send: "Enviar",
		stop: "Detener",
		attach: "Adjuntar archivos",
		files: "Archivos para enviar",
		remove: "Quitar",
		uploading: "Subiendo",
		failed: "No enviado",
		busy: "Añade algo a lo que estoy haciendo…",
		idle: "Pregunta lo que quieras…",
		talk: "Hablar",
		review: "Detener y revisar",
		direct: "Detener y enviar",
		listening: "Escuchando…",
		option: "Enviar al detener",
		cancel: "Cancelar grabación",
		cancelTitle: "Cancelar (Esc)",
		timer: "Tiempo de grabación",
		meter: "Nivel del micrófono",
		status: "Voz",
		transcribing: "Transcribiendo…",
		tip: "Pulsa para hablar y vuelve a pulsar para revisar antes de enviar",
		directTip: "Pulsa para hablar y vuelve a pulsar para enviar",
		failure:
			"No hay conexión, por lo que el mensaje no se ha enviado. Se conserva aquí para volver a enviarlo.",
	},
};

for (const locale of ["es", "en"] as const) {
	describe(`Composer display and data boundaries (${locale})`, () => {
		beforeEach(() => {
			if (locale === "es") localStorage.setItem(UI_LANGUAGE_KEY, locale);
		});
		const l = labels[locale];

		it("keeps keyboard semantics, exact text, request IDs, retry and abort", async () => {
			const send = vi.fn<(message: ClientMessage) => boolean>(() => false);
			const v = voice();
			const typing = vi.fn();
			const view = render(
				<LocaleProvider>
					<Composer busy={false} disabled={false} send={send} voice={v} onStartTyping={typing} />
				</LocaleProvider>,
			);
			const box = screen.getByRole("textbox", { name: l.message });
			expect(box).toHaveAttribute("placeholder", l.idle);
			expect(screen.getByRole("button", { name: l.send })).toBeDisabled();
			await userEvent.type(box, "   ");
			fireEvent.keyDown(box, { key: "Enter" });
			expect(send).not.toHaveBeenCalled();
			await userEvent.clear(box);
			await userEvent.type(box, "  English datos  ");
			fireEvent.keyDown(box, { key: "Enter", isComposing: true });
			expect(send).not.toHaveBeenCalled();
			await userEvent.type(box, "{Shift>}{Enter}{/Shift}segunda");
			expect(send).not.toHaveBeenCalled();
			fireEvent.keyDown(box, { key: "Enter" });
			expect(send).toHaveBeenCalledExactlyOnceWith({
				type: "send",
				text: "English datos  \nsegunda",
				requestId: expect.any(String),
			});
			expect(screen.getByRole("alert", { name: l.failed })).toHaveTextContent(l.failure);
			expect(box).toHaveValue("  English datos  \nsegunda");
			expect(v.sent).not.toHaveBeenCalled();
			send.mockReturnValue(true);
			await userEvent.click(screen.getByRole("button", { name: l.send }));
			expect(send).toHaveBeenCalledTimes(2);
			expect(send.mock.calls[1]?.[0]).toEqual({
				type: "send",
				text: "English datos  \nsegunda",
				requestId: expect.any(String),
			});
			expect(v.sent).toHaveBeenCalledTimes(1);
			expect(typing).toHaveBeenCalledTimes(2);
			expect(box).toHaveValue("");
			expect(screen.queryByRole("alert")).toBeNull();
			view.rerender(
				<LocaleProvider>
					<Composer busy disabled={false} send={send} voice={v} />
				</LocaleProvider>,
			);
			expect(box).toHaveAttribute("placeholder", l.busy);
			await userEvent.click(screen.getByRole("button", { name: l.stop }));
			expect(send.mock.calls).toHaveLength(3);
			expect(send).toHaveBeenLastCalledWith({ type: "abort" });
			expect(v.stopSpeaking).toHaveBeenCalledTimes(1);
		});

		it("localizes file wrappers without changing uploads, errors, names or retry payloads", async () => {
			const file = new File(["contenido"], "English report.txt", { type: "text/plain" });
			const ref: UploadedFile = {
				uploadId: "u_synthetic",
				name: file.name,
				size: file.size,
				mime: file.type,
				path: "uploads/u_synthetic/English report.txt",
			};
			let finish: (value: UploadedFile) => void = () => {};
			const upload = vi.fn<Uploader>(async (_file, options) => {
				options.onProgress?.(0.5);
				return new Promise((resolve) => {
					finish = resolve;
				});
			});
			const send = vi.fn<(message: ClientMessage) => boolean>(() => false);
			function Fixture() {
				const attachments = useAttachments(upload);
				return <Composer busy={false} disabled={false} send={send} attachments={attachments} />;
			}
			render(
				<LocaleProvider>
					<Fixture />
				</LocaleProvider>,
			);
			const input = screen.getByLabelText(l.attach);
			expect(input.closest("label")).toHaveAttribute("title", l.attach);
			await userEvent.upload(input, file);
			expect(screen.getByRole("list", { name: l.files })).toHaveTextContent(file.name);
			await userEvent.click(screen.getByRole("button", { name: `${l.remove} ${file.name}` }));
			expect(screen.queryByRole("list")).toBeNull();
			expect(upload).not.toHaveBeenCalled();
			await userEvent.upload(input, file);
			await userEvent.type(screen.getByRole("textbox", { name: l.message }), "read English");
			await userEvent.click(screen.getByRole("button", { name: l.send }));
			expect(screen.getByRole("progressbar", { name: `${l.uploading} ${file.name}` })).toHaveAttribute(
				"value",
				"0.5",
			);
			expect(screen.getByRole("button", { name: `${l.remove} ${file.name}` })).toBeDisabled();
			expect(screen.getByRole("button", { name: l.send })).toBeDisabled();
			expect(input).toBeDisabled();
			expect(send).not.toHaveBeenCalled();
			await act(async () => finish(ref));
			await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
			expect(upload.mock.calls[0]?.[0]).toBe(file);
			expect(send).toHaveBeenLastCalledWith({
				type: "send",
				text: "read English",
				requestId: expect.any(String),
				attachments: [{ uploadId: ref.uploadId, name: ref.name }],
			});
			send.mockReturnValue(true);
			await userEvent.click(screen.getByRole("button", { name: l.send }));
			expect(upload).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledTimes(2);
			expect(send).toHaveBeenLastCalledWith({
				type: "send",
				text: "read English",
				requestId: expect.any(String),
				attachments: [{ uploadId: ref.uploadId, name: ref.name }],
			});
			expect(screen.queryByRole("list")).toBeNull();
			await userEvent.upload(input, file);
			upload.mockRejectedValueOnce(new Error("Backend English error: /upload synthetic"));
			await userEvent.click(screen.getByRole("button", { name: l.send }));
			expect(await screen.findByRole("alert")).toHaveTextContent("Backend English error: /upload synthetic");
			expect(upload).toHaveBeenCalledTimes(2);
			expect(send).toHaveBeenCalledTimes(2);
		});

		it("localizes voice controls but preserves callback modes, partials, notes and reasons", async () => {
			const send = vi.fn();
			const v = voice();
			const view = render(
				<LocaleProvider>
					<Composer busy={false} disabled={false} send={send} voice={v} />
				</LocaleProvider>,
			);
			expect(screen.getByRole("button", { name: l.talk })).toHaveAttribute("title", l.tip);
			await userEvent.click(screen.getByRole("button", { name: l.talk }));
			expect(v.start).toHaveBeenCalledTimes(1);
			const update = (overrides: Partial<VoiceControls>, busy = false, disabled = false) =>
				view.rerender(
					<LocaleProvider>
						<Composer busy={busy} disabled={disabled} send={send} voice={{ ...v, ...overrides }} />
					</LocaleProvider>,
				);
			update({ phase: "recording" });
			expect(screen.queryByRole("textbox")).toBeNull();
			expect(screen.queryByRole("button", { name: l.send })).toBeNull();
			expect(screen.getByRole("timer", { name: l.timer })).toHaveTextContent("1:05");
			expect(screen.getByRole("meter", { name: l.meter })).toHaveAttribute("value", "0.4");
			expect(screen.getByText(l.listening)).toBeInTheDocument();
			expect(screen.getByRole("switch", { name: l.option })).toHaveAttribute("aria-checked", "false");
			await userEvent.click(screen.getByRole("switch", { name: l.option }));
			expect(v.setSendOnStop).toHaveBeenCalledExactlyOnceWith(true);
			await userEvent.click(screen.getByRole("button", { name: l.review }));
			expect(v.stop).toHaveBeenCalledTimes(1);
			expect(screen.getByRole("button", { name: l.cancel })).toHaveAttribute("title", l.cancelTitle);
			await userEvent.click(screen.getByRole("button", { name: l.cancel }));
			expect(v.cancel).toHaveBeenCalledTimes(1);
			update({ phase: "recording", sendOnStop: true, partial: "English dictated data" });
			expect(screen.getByText("English dictated data")).toBeInTheDocument();
			expect(screen.queryByText(l.listening)).toBeNull();
			expect(screen.getByRole("button", { name: l.direct })).toHaveAttribute("title", l.directTip);
			await userEvent.click(screen.getByRole("button", { name: l.direct }));
			expect(v.stop).toHaveBeenCalledTimes(2);
			await userEvent.click(screen.getByRole("switch", { name: l.option }));
			expect(v.setSendOnStop).toHaveBeenLastCalledWith(false);
			update({ phase: "transcribing", note: "English hook note" });
			expect(screen.getByRole("status", { name: l.status })).toHaveTextContent(l.transcribing);
			expect(screen.getByRole("button", { name: l.talk })).toBeDisabled();
			update({ note: "English hook note", mic: { available: false, reason: "English mic reason" } });
			expect(screen.getByRole("status", { name: l.status })).toHaveTextContent("English hook note");
			expect(screen.getByRole("button", { name: l.talk })).toHaveAttribute("title", "English mic reason");
			expect(screen.getByRole("button", { name: l.talk })).toBeDisabled();
			update({ speaking: true });
			await userEvent.click(screen.getByRole("button", { name: l.stop }));
			expect(v.stopSpeaking).toHaveBeenCalledTimes(1);
			expect(send).not.toHaveBeenCalled();
			update({}, false, true);
			expect(screen.getByRole("textbox")).toBeDisabled();
			expect(screen.getByRole("button", { name: l.talk })).toBeDisabled();
			expect(screen.getByRole("button", { name: l.send })).toBeDisabled();
		});
	});
}

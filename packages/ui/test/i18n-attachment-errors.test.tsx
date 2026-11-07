import type { ClientMessage, UploadedFile } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY, useLocale } from "../src/i18n.tsx";
import { createUploader, type Uploader } from "../src/uploads.ts";
import { type AttachmentControls, useAttachments } from "../src/useAttachments.ts";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

function file(name: string, size = 1) {
	const value = new File(["x"], name, { type: "text/plain" });
	Object.defineProperty(value, "size", { value: size });
	return value;
}

function fixture(upload: Uploader, locale = "es") {
	localStorage.setItem(UI_LANGUAGE_KEY, locale);
	let controls: AttachmentControls;
	const send = vi.fn<(message: ClientMessage) => boolean>(() => true);
	function Fixture() {
		controls = useAttachments(upload)!;
		const { setLocale } = useLocale();
		return (
			<>
				<button type="button" onClick={() => setLocale("en")}>
					English
				</button>
				<Composer busy={false} disabled={false} send={send} attachments={controls} />
			</>
		);
	}
	render(
		<LocaleProvider>
			<Fixture />
		</LocaleProvider>,
	);
	return {
		get controls() {
			return controls;
		},
		send,
	};
}

const fallback = "The upload did not work.";
const network = "The upload did not work. Check the connection and try again.";
const spanish = "La subida no ha funcionado.";
const spanishNetwork = "La subida no ha funcionado. Comprueba la conexión y vuelve a intentarlo.";

function transport(response: string | "network", status = 400) {
	const sent: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
	class Xhr {
		status = status;
		responseText = response;
		upload = {
			onprogress: null as
				| ((event: { loaded: number; total: number; lengthComputable: boolean }) => void)
				| null,
		};
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		method = "";
		url = "";
		headers: Record<string, string> = {};
		open(method: string, url: string) {
			this.method = method;
			this.url = url;
		}
		setRequestHeader(key: string, value: string) {
			this.headers[key] = value;
		}
		send(body: unknown) {
			sent.push({ method: this.method, url: this.url, headers: this.headers, body });
			this.upload.onprogress?.({ loaded: 1, total: 2, lengthComputable: true });
			if (response === "network") this.onerror?.();
			else this.onload?.();
		}
	}
	return {
		sent,
		upload: createUploader(
			{ url: "wss://synthetic.invalid/ws", token: "fixture-token" },
			Xhr as unknown as typeof XMLHttpRequest,
		),
	};
}

describe("attachment refusal display provenance", () => {
	it.each([
		[
			Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`)),
			"Too many files: up to 10 files per message.",
			"Demasiados archivos: hasta 10 archivos por mensaje.",
			10,
		],
		[
			[file("huge.bin", 25 * 1024 * 1024 + 1)],
			"Too large: up to 25 MB per file.",
			"Demasiado grande: hasta 25 MB por archivo.",
			0,
		],
		[
			[file("a", 25 * 1024 * 1024), file("b", 25 * 1024 * 1024), file("c", 1)],
			"Too large together: up to 50 MB per message.",
			"Demasiado grandes en conjunto: hasta 50 MB por mensaje.",
			2,
		],
	] as const)(
		"localizes a guard without changing rejected state or upload blocking (%s)",
		async (files, raw, display, kept) => {
			const upload = vi.fn<Uploader>();
			const f = fixture(upload);
			act(() => f.controls.add([...files]));
			expect(screen.getByRole("alert")).toHaveTextContent(display);
			expect(f.controls.files.filter((item) => !item.refused)).toHaveLength(kept);
			expect(f.controls.files.at(-1)?.refused).toBe(raw);
			expect(f.controls.uploading).toBe(false);
			expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
			await act(async () => expect(await f.controls.upload()).toBeUndefined());
			expect(upload).not.toHaveBeenCalled();
			expect(f.send).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: "English" }));
			expect(screen.getByRole("alert")).toHaveTextContent(raw);
			act(() => f.controls.remove(f.controls.files.at(-1)!.id));
			expect(f.controls.files).toHaveLength(kept);
			expect(screen.queryByRole("alert")).toBeNull();
		},
	);

	it("keeps exact boundaries, refuses only over limits, and excludes refused bytes from later additions", () => {
		const f = fixture(vi.fn<Uploader>());
		act(() =>
			f.controls.add([
				file("refused", 26 * 1024 * 1024),
				file("a", 25 * 1024 * 1024),
				file("b", 25 * 1024 * 1024),
			]),
		);
		expect(f.controls.files.map((item) => !!item.refused)).toEqual([true, false, false]);
		act(() => f.controls.clear());
		act(() => f.controls.add(Array.from({ length: 10 }, (_, i) => file(`${i}`, 0))));
		expect(f.controls.files.every((item) => !item.refused)).toBe(true);
		expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled();
	});
});

describe("upload fallback display provenance", () => {
	it.each([
		["{}", fallback, spanish],
		["not JSON", fallback, spanish],
		['{"message":42}', fallback, spanish],
		["network", network, spanishNetwork],
	])("localizes only a known transport fallback (%s)", async (response, raw, display) => {
		const t = transport(response);
		const input = file("English file.txt");
		await expect(t.upload(input, {})).rejects.toThrow(raw);
		const f = fixture(t.upload);
		act(() => f.controls.add([input]));
		await act(async () => expect(await f.controls.upload()).toBeUndefined());
		expect(screen.getByRole("alert")).toHaveTextContent(display);
		expect(f.controls.files[0]?.error).toBe(raw);
		expect(f.controls.files[0]?.progress).toBeUndefined();
		expect(f.controls.uploading).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "English" }));
		expect(screen.getByRole("alert")).toHaveTextContent(raw);
		expect(t.sent.at(-1)).toEqual({
			method: "POST",
			url: "https://synthetic.invalid/upload",
			headers: { Authorization: "Bearer fixture-token", "X-File-Name": "English%20file.txt" },
			body: input,
		});
	});

	it.each([fallback, network, "", "Native English /upload error"])(
		"preserves backend strings and collisions verbatim (%s)",
		async (message) => {
			const t = transport(JSON.stringify({ message }));
			await expect(t.upload(file("raw.txt"), {})).rejects.toHaveProperty("message", message);
			const f = fixture(t.upload);
			act(() => f.controls.add([file("raw.txt")]));
			await act(async () => {
				await f.controls.upload();
			});
			// Existing hook fallback on an empty Error.message remains English and unannotated.
			expect(f.controls.files[0]?.error).toBe(message || fallback);
			expect(screen.getByRole("alert")).toHaveTextContent(message || fallback);
		},
	);

	it("localizes a missing-message catch fallback but not native errors", async () => {
		const upload = vi
			.fn<Uploader>()
			.mockRejectedValueOnce({})
			.mockRejectedValueOnce(new Error(fallback))
			.mockRejectedValueOnce(new Error(""));
		const f = fixture(upload);
		act(() => f.controls.add([file("raw.txt")]));
		await act(async () => {
			await f.controls.upload();
		});
		expect(screen.getByRole("alert")).toHaveTextContent(spanish);
		expect(f.controls.files[0]?.error).toBe(fallback);
		await act(async () => {
			await f.controls.upload();
		});
		expect(screen.getByRole("alert")).toHaveTextContent(fallback);
		expect(f.controls.files[0]?.progress).toBeUndefined();
		expect(f.controls.files[0]?.errorDisplay).toBeUndefined();
		await act(async () => {
			await f.controls.upload();
		});
		expect(screen.getByRole("alert")).toHaveTextContent(fallback);
		expect(f.controls.files[0]?.errorDisplay).toBeUndefined();
	});

	it("keeps legacy unannotated refusal/error props raw, including empty precedence", () => {
		localStorage.setItem(UI_LANGUAGE_KEY, "es");
		const controls: AttachmentControls = {
			files: [
				{
					id: "raw-refusal",
					file: file("raw-refusal"),
					refused: "Too many files: up to 10 files per message.",
				},
				{ id: "raw-error", file: file("raw-error"), error: fallback },
				{ id: "empty", file: file("empty"), refused: "", error: network },
			],
			uploading: false,
			add: vi.fn(),
			remove: vi.fn(),
			clear: vi.fn(),
			upload: vi.fn(),
		};
		render(
			<LocaleProvider>
				<Composer busy={false} disabled={false} send={vi.fn()} attachments={controls} />
			</LocaleProvider>,
		);
		expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
			"Too many files: up to 10 files per message.",
			fallback,
		]);
		expect(screen.queryByText(network)).toBeNull();
	});

	it("clears display metadata on retry, preserves shared folder and exact send payload", async () => {
		const t = transport("network");
		const upload = vi
			.fn<Uploader>()
			.mockImplementationOnce(t.upload)
			.mockImplementation(async (input, options) => {
				options.onProgress?.(0.5);
				return {
					uploadId: options.uploadId ?? "u_fixture",
					name: input.name,
					size: input.size,
					mime: input.type,
					path: `uploads/u_fixture/${input.name}`,
				} satisfies UploadedFile;
			});
		const f = fixture(upload);
		const inputs = [file("a.txt"), file("b.txt")];
		act(() => f.controls.add(inputs));
		fireEvent.change(screen.getByRole("textbox"), { target: { value: " English content " } });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
		});
		expect(screen.getByRole("alert")).toHaveTextContent(spanishNetwork);
		expect(f.send).not.toHaveBeenCalled();
		expect(f.controls.files[1]?.uploaded?.name).toBe("b.txt");
		let finish: () => void = () => {};
		upload.mockImplementationOnce(
			(input, options) =>
				new Promise((resolve) => {
					finish = () =>
						resolve({
							uploadId: options.uploadId!,
							name: input.name,
							size: input.size,
							mime: input.type,
							path: `uploads/u_fixture/${input.name}`,
						});
				}),
		);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
		});
		expect(f.controls.files[0]?.error).toBeUndefined();
		expect(f.controls.files[0]?.errorDisplay).toBeUndefined();
		expect(f.controls.files[0]?.progress).toBe(0);
		expect(f.controls.uploading).toBe(true);
		await act(async () => finish());
		expect(upload).toHaveBeenCalledTimes(3);
		expect(upload.mock.calls[2]?.[1].uploadId).toBe("u_fixture");
		expect(f.send).toHaveBeenCalledExactlyOnceWith({
			type: "send",
			text: "English content",
			requestId: expect.any(String),
			attachments: [
				{ uploadId: "u_fixture", name: "a.txt" },
				{ uploadId: "u_fixture", name: "b.txt" },
			],
		});
		expect(f.controls.files).toEqual([]);
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

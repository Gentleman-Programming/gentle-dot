import type { ClientMessage, ServerMessage, ServerPayload, UploadedFile } from "@gentle-dot/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { Composer } from "../src/components/Composer.tsx";
import { MessageList } from "../src/components/MessageList.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";
import { createUploader, formatSize, type Uploader, uploadBase } from "../src/uploads.ts";
import { useAttachments } from "../src/useAttachments.ts";

const open: DotState = { ...initialState, connection: "open", agentState: "idle" };

function file(name: string, size = 10, type = "text/plain"): File {
	return new File([new Uint8Array(size)], name, { type });
}

function uploaded(f: File, uploadId = "u_0123456789abcdef"): UploadedFile {
	return {
		uploadId,
		name: f.name,
		size: f.size,
		mime: f.type || "application/octet-stream",
		path: `uploads/${uploadId}/${f.name}`,
	};
}

/** An uploader that answers right away, recording each call. */
function instantUploader() {
	return vi.fn<Uploader>(async (f, options) => {
		options.onProgress?.(1);
		return uploaded(f, options.uploadId ?? "u_0123456789abcdef");
	});
}

function ComposerWith({ upload, send }: { upload: Uploader; send: (m: ClientMessage) => void }) {
	const attachments = useAttachments(upload);
	return <Composer busy={false} disabled={false} send={send} attachments={attachments} />;
}

const attachInput = () => screen.getByLabelText("Attach files") as HTMLInputElement;
const chips = () => within(screen.getByRole("list", { name: "Files to send" })).queryAllByRole("listitem");

describe("attaching files in the composer", () => {
	it("adds chosen files as chips with name and size, and removes one", async () => {
		render(<ComposerWith upload={instantUploader()} send={vi.fn()} />);
		await userEvent.upload(attachInput(), [file("notes.txt", 2048), file("photo.png", 10, "image/png")]);
		expect(chips().map((c) => c.textContent)).toEqual([
			expect.stringContaining("notes.txt"),
			expect.stringContaining("photo.png"),
		]);
		expect(chips()[0]?.textContent).toContain("2 KB");
		await userEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
		expect(chips()).toHaveLength(1);
	});

	it("uploads on send with one message folder, then sends the text with the attachments", async () => {
		const upload = instantUploader();
		upload.mockImplementationOnce(async (f, options) => {
			options.onProgress?.(1);
			return uploaded(f, "u_first0000000000000");
		});
		const send = vi.fn<(m: ClientMessage) => void>();
		render(<ComposerWith upload={upload} send={send} />);
		await userEvent.upload(attachInput(), [file("a.txt"), file("b.txt")]);
		await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "read these{Enter}");
		await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(upload.mock.calls.map(([f, o]) => [f.name, o.uploadId])).toEqual([
			["a.txt", undefined],
			["b.txt", "u_first0000000000000"],
		]);
		expect(send.mock.calls[0]?.[0]).toMatchObject({
			type: "send",
			text: "read these",
			attachments: [
				{ uploadId: "u_first0000000000000", name: "a.txt" },
				{ uploadId: "u_first0000000000000", name: "b.txt" },
			],
		});
		expect(screen.queryByRole("list", { name: "Files to send" })).toBeNull();
		expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
	});

	it("sends files without text", async () => {
		const send = vi.fn<(m: ClientMessage) => void>();
		render(<ComposerWith upload={instantUploader()} send={send} />);
		await userEvent.upload(attachInput(), [file("a.txt")]);
		await userEvent.click(screen.getByRole("button", { name: "Send" }));
		await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(send.mock.calls[0]?.[0]).toMatchObject({ type: "send", text: "" });
	});

	it("shows progress while uploading", async () => {
		let finish: (value: UploadedFile) => void = () => {};
		const upload = vi.fn<Uploader>(
			(f, options) =>
				new Promise((resolve) => {
					options.onProgress?.(0.5);
					finish = () => resolve(uploaded(f));
				}),
		);
		const send = vi.fn();
		render(<ComposerWith upload={upload} send={send} />);
		await userEvent.upload(attachInput(), [file("a.txt")]);
		await userEvent.click(screen.getByRole("button", { name: "Send" }));
		const bar = await screen.findByRole("progressbar", { name: "Uploading a.txt" });
		expect(bar).toHaveAttribute("value", "0.5");
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		await act(async () => finish(uploaded(file("a.txt"))));
		await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
	});

	it("shows an upload error on the file and keeps the message", async () => {
		const upload = vi.fn<Uploader>(async () => {
			throw new Error("This file is too large: up to 25 MB per file.");
		});
		const send = vi.fn();
		render(<ComposerWith upload={upload} send={send} />);
		await userEvent.upload(attachInput(), [file("a.txt")]);
		await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "hi{Enter}");
		const chip = chips()[0] as HTMLElement;
		expect(await within(chip).findByRole("alert")).toHaveTextContent("too large");
		expect(send).not.toHaveBeenCalled();
		expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("hi");
	});

	it("refuses files over the limits before uploading, with a reason on the chip", async () => {
		const upload = instantUploader();
		const first = render(<ComposerWith upload={upload} send={vi.fn()} />);
		await userEvent.upload(attachInput(), [file("huge.bin", 26 * 1024 * 1024)]);
		expect(within(chips()[0] as HTMLElement).getByRole("alert")).toHaveTextContent(/25 MB/);
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
		first.unmount();

		render(<ComposerWith upload={upload} send={vi.fn()} />);
		await userEvent.upload(
			attachInput(),
			Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`)),
		);
		const refused = chips().filter((c) => within(c).queryByRole("alert"));
		expect(refused).toHaveLength(1);
		expect(refused[0]).toHaveTextContent("f10.txt");
		expect(refused[0]).toHaveTextContent(/10 files/);
		expect(upload).not.toHaveBeenCalled();
	});

	it("adds a pasted image and leaves pasted text alone", async () => {
		render(<ComposerWith upload={instantUploader()} send={vi.fn()} />);
		const box = screen.getByRole("textbox", { name: "Message" });
		fireEvent.paste(box, {
			clipboardData: { files: [file("image.png", 10, "image/png")], types: ["Files"] },
		});
		expect(chips().map((c) => c.textContent)).toEqual([expect.stringContaining("image.png")]);
		fireEvent.paste(box, { clipboardData: { files: [], types: ["text/plain"] } });
		expect(chips()).toHaveLength(1);
	});

	it("has no attach button without an uploader, and a plain send is unchanged", async () => {
		const send = vi.fn();
		render(<Composer busy={false} disabled={false} send={send} />);
		expect(screen.queryByLabelText("Attach files")).toBeNull();
		await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "hello{Enter}");
		expect(send).toHaveBeenCalledWith({ type: "send", text: "hello", requestId: expect.any(String) });
	});
});

describe("dropping files on the chat", () => {
	it("adds dropped files to the message", async () => {
		const { container } = render(
			<ChatSurface variant="web" state={open} send={vi.fn()} dismiss={vi.fn()} upload={instantUploader()} />,
		);
		const chat = container.querySelector(".chat") as HTMLElement;
		const dropped = file("dropped.pdf", 100, "application/pdf");
		fireEvent.dragOver(chat, { dataTransfer: { types: ["Files"], files: [] } });
		expect(chat.className).toContain("chat-dropping");
		fireEvent.drop(chat, { dataTransfer: { types: ["Files"], files: [dropped] } });
		expect(chat.className).not.toContain("chat-dropping");
		expect(chips().map((c) => c.textContent)).toEqual([expect.stringContaining("dropped.pdf")]);
	});
});

let seq = 0;
const apply = (state: DotState, payload: ServerPayload) =>
	reduce(state, { type: "server", message: { ...payload, seq: ++seq } as ServerMessage });

describe("sent messages with files", () => {
	it("keeps the attachments of a user message and shows them as chips", () => {
		const s = apply(open, {
			type: "user_message",
			messageId: "u1",
			text: "look",
			attachments: [{ name: "report.pdf", size: 2048, mime: "application/pdf" }],
		});
		expect(s.messages[0]?.attachments).toEqual([{ name: "report.pdf", size: 2048, mime: "application/pdf" }]);
		render(<MessageList messages={s.messages} />);
		const list = screen.getByRole("list", { name: "Attached files" });
		expect(within(list).getByRole("listitem")).toHaveTextContent("report.pdf");
		expect(within(list).getByRole("listitem")).toHaveTextContent("2 KB");
	});
});

describe("the uploader", () => {
	it("posts the raw file to the daemon's /upload with the key in a header", async () => {
		const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
		class FakeXhr {
			status = 0;
			responseText = "";
			upload = {
				onprogress: null as
					| ((e: { loaded: number; total: number; lengthComputable: boolean }) => void)
					| null,
			};
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			private url = "";
			private headers: Record<string, string> = {};
			open(_method: string, url: string) {
				this.url = url;
			}
			setRequestHeader(name: string, value: string) {
				this.headers[name] = value;
			}
			send(body: unknown) {
				sent.push({ url: this.url, headers: this.headers, body });
				this.upload.onprogress?.({ loaded: 5, total: 10, lengthComputable: true });
				this.status = this.headers["X-File-Name"] === "bad.txt" ? 413 : 200;
				this.responseText = JSON.stringify(
					this.status === 200
						? uploaded(file("a b.txt"), "u_server000000000000")
						: { code: "file_too_large", message: "This file is too large." },
				);
				this.onload?.();
			}
		}
		const upload = createUploader(
			{ url: "ws://127.0.0.1:4317/ws", token: "secret-key" },
			FakeXhr as unknown as typeof XMLHttpRequest,
		);
		const progress: number[] = [];
		const result = await upload(file("a b.txt"), {
			uploadId: "u_prev0000000000000000",
			onProgress: (p) => progress.push(p),
		});
		expect(result.uploadId).toBe("u_server000000000000");
		expect(sent[0]?.url).toBe("http://127.0.0.1:4317/upload");
		expect(sent[0]?.headers).toMatchObject({
			Authorization: "Bearer secret-key",
			"X-File-Name": "a%20b.txt",
			"X-Upload-Id": "u_prev0000000000000000",
		});
		expect(sent[0]?.url).not.toContain("secret-key");
		expect(progress).toContain(0.5);
		await expect(upload(file("bad.txt"), {})).rejects.toThrow("This file is too large.");
	});

	it("derives the HTTP address from the WebSocket one, and formats sizes", () => {
		expect(uploadBase("ws://127.0.0.1:4317/ws")).toBe("http://127.0.0.1:4317");
		expect(uploadBase("wss://dot.example.com/ws")).toBe("https://dot.example.com");
		expect(formatSize(512)).toBe("512 B");
		expect(formatSize(2048)).toBe("2 KB");
		expect(formatSize(5 * 1024 * 1024)).toBe("5 MB");
		expect(formatSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
	});
});

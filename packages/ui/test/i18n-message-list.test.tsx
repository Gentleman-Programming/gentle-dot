import type { Activity, ActivityKind } from "@gentle-dot/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "../src/components/MessageList.tsx";
import { LocaleProvider, UI_LANGUAGE_KEY } from "../src/i18n.tsx";
import type { ChatMessage } from "../src/store.ts";

beforeEach(() => window.localStorage.setItem(UI_LANGUAGE_KEY, "es"));
afterEach(() => window.localStorage.clear());

function message(activities: Activity[] = []): ChatMessage {
	return { id: "answer", role: "assistant", text: "All **good**", streaming: false, activities };
}

function show(
	messages: ChatMessage[],
	props: { queued?: string[]; hasEarlier?: boolean; onShowEarlier?: () => void } = {},
) {
	return render(
		<LocaleProvider>
			<MessageList messages={messages} {...props} />
		</LocaleProvider>,
	);
}

const grammar: [ActivityKind, string, string][] = [
	["read", "Leyó 1 archivo", "Leyó 2 archivos"],
	["edit", "Editó 1 archivo", "Editó 2 archivos"],
	["run", "Ejecutó 1 comando", "Ejecutó 2 comandos"],
	["search", "Buscó 1 vez", "Buscó 2 veces"],
	["memory", "Usó la memoria 1 vez", "Usó la memoria 2 veces"],
	["delegate", "Consultó a 1 asistente", "Consultó a 2 asistentes"],
	["other", "Realizó 1 paso", "Realizó 2 pasos"],
];

function activity(kind: ActivityKind, id: string): Activity {
	return { id, kind, title: `Raw ${kind} ${id}`, status: "done" };
}

describe("MessageList Spanish authored chrome", () => {
	it("translates only the empty greeting", () => {
		show([]);
		expect(screen.getByText("¡Hola! ¿En qué puedo ayudarte?")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("keeps earlier callbacks, filenames, user/assistant text, error notes and queued data exact", () => {
		const onShowEarlier = vi.fn();
		const messages: ChatMessage[] = [
			{
				id: "user",
				role: "user",
				text: "first line\nsecond",
				earlier: true,
				streaming: false,
				activities: [],
				attachments: [{ name: "Read report.md", size: 2048, mime: "text/markdown" }],
			},
			{ ...message(), note: { kind: "error", text: "Backend failed: Read report.md" } },
		];
		const queued = ["Queued", "Queued"];
		const before = JSON.stringify({ messages, queued });
		const { container } = show(messages, { queued, hasEarlier: true, onShowEarlier: () => onShowEarlier() });
		fireEvent.click(screen.getByRole("button", { name: "Mostrar anteriores" }));
		expect(onShowEarlier.mock.calls).toEqual([[]]);
		expect(screen.getByRole("separator", { name: "Mensajes anteriores" })).toBeInTheDocument();
		expect(screen.getByText("Mensajes anteriores")).toHaveAttribute("aria-hidden", "true");
		expect(screen.getByRole("list", { name: "Archivos adjuntos" })).toHaveTextContent("Read report.md2 KB");
		expect(screen.getByTitle("Read report.md").textContent).toBe("Read report.md");
		expect(container.querySelector(".message-plain")?.textContent).toBe("first line\nsecond");
		expect(screen.getByText("good").tagName).toBe("STRONG");
		expect(screen.getByRole("alert").textContent).toBe("Backend failed: Read report.md");
		expect(screen.getAllByRole("article", { name: "Mensaje en cola" })).toHaveLength(2);
		expect(
			[...container.querySelectorAll(".message-queued .message-body")].map((node) => node.textContent),
		).toEqual(queued);
		expect(screen.getAllByText("En cola")).toHaveLength(2);
		expect(JSON.stringify({ messages, queued })).toBe(before);
	});

	it("renders queued-only state instead of the empty greeting and hides absent controls", () => {
		show([], { queued: ["Hi! What can I do for you?"] });
		expect(screen.getByRole("article", { name: "Mensaje en cola" })).toHaveTextContent(
			"Hi! What can I do for you?",
		);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.queryByRole("separator")).not.toBeInTheDocument();
	});

	it.each(grammar)(
		"uses singular and plural %s grammar without changing activity titles",
		(kind, one, many) => {
			const activities = [activity(kind, "a")];
			const { rerender } = show([message(activities)]);
			expect(screen.getByRole("button", { name: one })).toHaveAttribute("aria-expanded", "false");
			const pair = [...activities, activity(kind, "b")];
			rerender(
				<LocaleProvider>
					<MessageList messages={[message(pair)]} />
				</LocaleProvider>,
			);
			fireEvent.click(screen.getByRole("button", { name: many }));
			expect(screen.getByRole("button", { name: many })).toHaveAttribute("aria-expanded", "true");
			for (const item of pair) expect(screen.getByText(item.title).textContent).toBe(item.title);
			fireEvent.click(screen.getByRole("button", { name: many }));
			expect(screen.queryByText(pair[0]?.title ?? "")).not.toBeInTheDocument();
		},
	);

	it("keeps first-seen kind order and counts failed activities in mixed summaries", () => {
		show([
			message([
				activity("run", "a"),
				activity("read", "b"),
				{ ...activity("run", "c"), status: "failed" },
				activity("other", "d"),
			]),
		]);
		expect(
			screen.getByRole("button", { name: "Ejecutó 2 comandos · Leyó 1 archivo · Realizó 1 paso" }),
		).toBeInTheDocument();
	});

	it("keeps stopped notes and streaming chrome without inventing activity summaries", () => {
		const { container } = show([
			{ ...message(), streaming: true, note: { kind: "stopped", text: "Backend note stays English" } },
		]);
		expect(screen.getByText("Backend note stays English")).toHaveClass("message-note-stopped");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(container.querySelector(".caret")).toHaveAttribute("aria-hidden", "true");
	});

	it("uses the first running title verbatim rather than the localized summary", () => {
		show([
			message([
				{ ...activity("read", "a"), title: "Read raw.md", status: "running" },
				{ ...activity("run", "b"), status: "running" },
			]),
		]);
		const button = screen.getByRole("button", { name: "Read raw.md" });
		expect(button.querySelector(".pulse")).toBeInTheDocument();
		fireEvent.click(button);
		expect(screen.getByRole("list").textContent).toBe("Read raw.mdRaw run b");
	});
});

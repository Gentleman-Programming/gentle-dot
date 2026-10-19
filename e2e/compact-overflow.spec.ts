import { expect, type Page, test } from "@playwright/test";
import { E2E_CONVERSATIONS_PORT, E2E_TOKEN } from "./token.ts";

// The compact chat is 420x640 logical units on macOS and on Niri (PANEL_SIZE /
// unit_surface::PANEL_W): showing the rose widens the Niri window, never the chat.
// Long prose must wrap inside that column; only a code block or a table may scroll,
// and then inside itself, never as a scrollbar on the chat body.
test.use({ viewport: { width: 420, height: 640 } });

// Each case starts a new conversation, so one shape's overflow cannot hide in the next.
const WITH_CONVERSATIONS = `http://127.0.0.1:${E2E_CONVERSATIONS_PORT}`;

async function openFresh(page: Page) {
	await page.goto(`${WITH_CONVERSATIONS}/?surface=panel#token=${E2E_TOKEN}`);
	await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
	await page.getByRole("button", { name: "New conversation" }).click();
	await expect(page.getByText("Hi! What can I do for you?")).toBeVisible();
}

/**
 * Sends `text` and waits for the answer. The assistant echoes the message, so the
 * content must survive the leading `Echo: ` on its first line to render as Markdown
 * blocks: every fixture starts with a short line and a blank line.
 */
async function say(page: Page, text: string) {
	const box = page.getByRole("textbox", { name: "Message" });
	await box.fill(text);
	await box.press("Enter");
	await expect(page.locator(".message-assistant").last()).toContainText("Echo:");
}

async function measure(page: Page) {
	return page.evaluate(() => {
		const body = document.querySelector<HTMLElement>(".chat-body");
		if (!body) throw new Error("no .chat-body");
		const widest: { tag: string; cls: string; over: number; overflowX: string }[] = [];
		for (const el of body.querySelectorAll<HTMLElement>("*")) {
			const over = el.scrollWidth - el.clientWidth;
			if (over > 1)
				widest.push({
					tag: el.tagName.toLowerCase(),
					cls: el.className.toString(),
					over,
					overflowX: getComputedStyle(el).overflowX,
				});
		}
		widest.sort((a, b) => b.over - a.over);
		const last = document.querySelector<HTMLElement>(".message-assistant:last-of-type .message-body");
		return {
			body: { clientWidth: body.clientWidth, scrollWidth: body.scrollWidth },
			outerOverflow: body.scrollWidth - body.clientWidth,
			lastMessage: last ? { clientWidth: last.clientWidth, scrollWidth: last.scrollWidth } : undefined,
			widest: widest.slice(0, 5),
			rendered: {
				lists: body.querySelectorAll("li").length,
				codeBlocks: body.querySelectorAll("pre").length,
				tables: body.querySelectorAll("table").length,
			},
		};
	});
}

/** Each shape must render as the Markdown block it targets, or the case proves nothing. */
const SHAPES: {
	name: string;
	text: string;
	rendered: (r: Awaited<ReturnType<typeof measure>>["rendered"]) => boolean;
}[] = [
	{
		name: "long list items with inline code",
		text: [
			"Notas:",
			"",
			"- **Porta:** `python-gobject`, `xdg-desktop-portal` + `gtk` + `hyprland`, pero no tenés `xdg-desktop-portal-wlr` ni `gnome`.",
			"- **Sistema:** `systemctl`, `journalctl`, `pacman`/`paru`, `docker`, `gh` instalados.",
			"- **Ojos y manos:** necesito ver la pantalla (screenshot) y clickear/teclear apps nativas Wayland que `bash` solo no puede.",
		].join("\n"),
		rendered: (r) => r.lists >= 3,
	},
	{
		name: "one unbreakable token longer than the column",
		text: `Token:\n\nghp_${"9f3c2b7a1d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60".repeat(3)}`,
		rendered: () => true,
	},
	{
		name: "a wide Markdown table",
		text: [
			"Tabla:",
			"",
			"| Comando | Qué hace | Notas |",
			"| --- | --- | --- |",
			"| `niri msg --json windows` | lista las ventanas | incluye workspace_id e is_floating |",
			"| `niri msg action focus-window --id 42` | enfoca una ventana | requiere el id exacto |",
		].join("\n"),
		rendered: (r) => r.tables >= 1,
	},
	{
		name: "a fenced code block with long lines",
		text: [
			"Código:",
			"",
			"```bash",
			`niri msg --json windows | jq '.[] | select(.app_id == "gentle-dot") | .id, .title, .workspace_id, .is_floating' --compact-output`,
			"```",
		].join("\n"),
		rendered: (r) => r.codeBlocks >= 1,
	},
];

for (const shape of SHAPES)
	test(`${shape.name} never widens the compact chat`, async ({ page }) => {
		await openFresh(page);
		await say(page, shape.text);
		const measured = await measure(page);
		console.log(`SHAPE ${shape.name}\n${JSON.stringify(measured, null, 2)}`);
		// A fixture that did not render proves nothing: fail loudly instead of passing.
		expect(shape.rendered(measured.rendered), JSON.stringify(measured.rendered)).toBe(true);
		expect(measured.outerOverflow).toBeLessThanOrEqual(1);
	});

test("a long code block still scrolls inside itself", async ({ page }) => {
	await openFresh(page);
	await say(page, ["Código:", "", "```bash", `echo ${"a".repeat(400)}`, "```"].join("\n"));
	const measured = await measure(page);
	console.log(`SHAPE long code block still scrolls\n${JSON.stringify(measured, null, 2)}`);
	expect(measured.rendered.codeBlocks).toBeGreaterThanOrEqual(1);
	expect(measured.outerOverflow).toBeLessThanOrEqual(1);
	const scrolls = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>(".chat-body pre")].some(
			(pre) => pre.scrollWidth > pre.clientWidth,
		),
	);
	expect(scrolls).toBe(true);
});

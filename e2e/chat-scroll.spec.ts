import { expect, type Page, test } from "@playwright/test";
import { E2E_CONVERSATIONS_PORT, E2E_TOKEN } from "./token.ts";

// The compact chat is 420x640 logical units (PANEL_SIZE / unit_surface::PANEL_W).
test.use({ viewport: { width: 420, height: 640 } });

const WITH_CONVERSATIONS = `http://127.0.0.1:${E2E_CONVERSATIONS_PORT}`;

async function openFresh(page: Page) {
	await page.goto(`${WITH_CONVERSATIONS}/?surface=panel#token=${E2E_TOKEN}`);
	await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
	await page.getByRole("button", { name: "New conversation" }).click();
	await expect(page.getByText("Hi! What can I do for you?")).toBeVisible();
}

async function say(page: Page, text: string) {
	const box = page.getByRole("textbox", { name: "Message" });
	await box.fill(text);
	await box.press("Enter");
	await expect(page.locator(".message-assistant").last()).toContainText("Echo:");
}

/** Sends `count` long messages so the conversation overflows the 640px panel. */
async function overflow(page: Page, count: number) {
	for (let i = 1; i <= count; i++) await say(page, `Mensaje ${i}\n\n${"contenido largo ".repeat(30)}`);
}

/** `.chat-body` is the scroll container, and it must really overflow or the case proves nothing. */
async function scroll(page: Page) {
	const measured = await page.evaluate(() => {
		const body = document.querySelector<HTMLElement>(".chat-body");
		if (!body) throw new Error("no .chat-body");
		const last = document.querySelector<HTMLElement>(".message:last-of-type");
		const bodyBox = body.getBoundingClientRect();
		const lastBox = last?.getBoundingClientRect();
		return {
			scrollTop: Math.round(body.scrollTop),
			max: Math.round(body.scrollHeight - body.clientHeight),
			messages: document.querySelectorAll(".message").length,
			// How far the newest message's bottom sits below the visible area; <= 1 means fully shown.
			lastBottomBelow: lastBox ? Math.round(lastBox.bottom - bodyBox.bottom) : null,
		};
	});
	return measured;
}

test("reopening the app lands on the newest message", async ({ page }) => {
	await openFresh(page);
	await overflow(page, 3);
	const before = await scroll(page);
	console.log(`BEFORE RELOAD ${JSON.stringify(before)}`);
	expect(before.max, "the conversation must overflow the panel to prove anything").toBeGreaterThan(0);

	await page.reload();
	await expect(page.locator(".message-assistant").last()).toBeVisible();
	const after = await scroll(page);
	console.log(`AFTER RELOAD ${JSON.stringify(after)}`);
	expect(after.messages, "history must be restored, or this case proves nothing").toBeGreaterThan(0);
	expect(after.lastBottomBelow).toBeLessThanOrEqual(1);
});

test("a new message stays visible when it arrives", async ({ page }) => {
	await openFresh(page);
	await overflow(page, 3);
	await say(page, `Ultimo\n\n${"contenido largo ".repeat(30)}`);
	const measured = await scroll(page);
	console.log(`NEW MESSAGE ${JSON.stringify(measured)}`);
	expect(measured.max).toBeGreaterThan(0);
	expect(measured.lastBottomBelow).toBeLessThanOrEqual(1);
});

test("showing earlier messages keeps the view on the messages it was reading", async ({ page }) => {
	await openFresh(page);
	await overflow(page, 4);
	await page.reload();
	await expect(page.locator(".message-assistant").last()).toBeVisible();
	const earlier = page.getByRole("button", { name: "Show earlier" });
	expect(await earlier.count(), "an earlier page must exist, or this case proves nothing").toBe(1);
	const anchor = page.locator(".message-assistant").last();
	const beforeBox = await anchor.boundingBox();
	const before = await scroll(page);
	// dispatchEvent clicks the button where it is: clicking would first scroll it into view, which
	// would move the view by itself and measure the harness instead of the app.
	await earlier.dispatchEvent("click");
	await expect(page.locator(".message-user").first()).toContainText("Mensaje 1");
	const afterBox = await anchor.boundingBox();
	const after = await scroll(page);
	console.log(`EARLIER before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
	expect(before.max, "the earlier page must really prepend content").toBeLessThan(after.max);
	expect(beforeBox && afterBox).toBeTruthy();
	// Prepending must keep the view on the same messages, not send it to the newest one.
	expect(Math.abs((afterBox?.y ?? 0) - (beforeBox?.y ?? 0))).toBeLessThanOrEqual(1);
});

test("an empty conversation is unchanged", async ({ page }) => {
	await openFresh(page);
	await expect(page.getByText("Hi! What can I do for you?")).toBeVisible();
	expect(await scroll(page)).toMatchObject({ messages: 0, scrollTop: 0, max: 0 });
});

import { expect, type Page, test } from "@playwright/test";
import { E2E_CONVERSATIONS_PORT, E2E_TOKEN } from "./token.ts";

// The compact chat is 420x640 logical units (PANEL_SIZE / unit_surface::PANEL_W).
test.use({ viewport: { width: 420, height: 640 } });

const WITH_CONVERSATIONS = `http://127.0.0.1:${E2E_CONVERSATIONS_PORT}`;
/** The conversation region itself: focusable, so the chat's own keys can reach it. */
const REGION = ".chat-body[tabindex='0']";

async function say(page: Page, text: string) {
	const box = page.getByRole("textbox", { name: "Message" });
	await box.fill(text);
	await box.press("Enter");
	await expect(page.locator(".message-assistant").last()).toContainText("Echo:");
}

async function scroll(page: Page) {
	return page.evaluate(() => {
		const body = document.querySelector<HTMLElement>(".chat-body[tabindex='0']");
		if (!body) throw new Error("no conversation region");
		return {
			scrollTop: Math.round(body.scrollTop),
			max: Math.round(body.scrollHeight - body.clientHeight),
		};
	});
}

test("the chat's own keys jump to the first and the last message", async ({ page }) => {
	await page.goto(`${WITH_CONVERSATIONS}/?surface=panel#token=${E2E_TOKEN}`);
	await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
	await page.getByRole("button", { name: "New conversation" }).click();
	for (let i = 1; i <= 3; i++) await say(page, `Mensaje ${i}\n\n${"contenido largo ".repeat(30)}`);
	await page.locator(REGION).focus();
	const before = await scroll(page);
	console.log(`KEYS start ${JSON.stringify(before)}`);
	expect(before.max, "the conversation must overflow to prove anything").toBeGreaterThan(0);

	await page.keyboard.press("Control+Home");
	const atTop = await scroll(page);
	console.log(`KEYS after Ctrl+Home ${JSON.stringify(atTop)}`);
	expect(atTop.scrollTop).toBe(0);

	await page.keyboard.press("Control+End");
	const atEnd = await scroll(page);
	console.log(`KEYS after Ctrl+End ${JSON.stringify(atEnd)}`);
	expect(atEnd.scrollTop).toBe(atEnd.max);
});

test("Esc closes the overlay in front of the user, and only then is it the app's key", async ({ page }) => {
	await page.goto(`${WITH_CONVERSATIONS}/?surface=panel#token=${E2E_TOKEN}`);
	await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
	// Records what the app's own window listener would see, without touching the app.
	await page.evaluate(() => {
		(window as unknown as { esc: boolean[] }).esc = [];
		window.addEventListener("keydown", (event) => {
			if (event.key === "Escape") (window as unknown as { esc: boolean[] }).esc.push(event.defaultPrevented);
		});
	});
	const seen = () => page.evaluate(() => (window as unknown as { esc: boolean[] }).esc);

	// Nothing open: the surface leaves Esc to the app, which hides the panel.
	await page.keyboard.press("Escape");
	expect(await seen()).toEqual([false]);

	// With an overlay open, Esc closes it exactly like its own ×.
	await say(page, "/login");
	const accounts = page.getByRole("region", { name: "Accounts" });
	await expect(accounts).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(accounts).toHaveCount(0);
	expect(await seen()).toEqual([false, true]);
	// The panel is still there, showing the conversation again.
	await expect(page.locator(REGION)).toBeVisible();
});

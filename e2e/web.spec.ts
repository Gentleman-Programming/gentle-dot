import { expect, type Page, test } from "@playwright/test";
import { E2E_TOKEN } from "./token.ts";

async function open(page: Page) {
	await page.goto(`/#token=${E2E_TOKEN}`);
	await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
}

async function say(page: Page, text: string) {
	const box = page.getByRole("textbox", { name: "Message" });
	await box.fill(text);
	await box.press("Enter");
}

test("chats and streams the answer, and removes the token from the address bar", async ({ page }) => {
	await open(page);
	expect(page.url()).not.toContain("token");
	await say(page, "hello there");
	await expect(page.locator(".message-user").last()).toHaveText("hello there");
	await expect(page.locator(".message-assistant").last()).toHaveText("Echo: hello there");
});

test("answers a question card", async ({ page }) => {
	await open(page);
	await say(page, "ask:select");
	const card = page.getByRole("region", { name: "The assistant needs your answer" });
	await expect(card).toContainText("Pick a color");
	await card.getByRole("button", { name: "Blue" }).click();
	await expect(card).toBeHidden();
	await expect(page.locator(".message-assistant").last()).toHaveText("You chose Blue");
});

test("starts a new conversation and reopens the previous one", async ({ page }) => {
	await open(page);
	await page.getByRole("button", { name: "New conversation" }).click();
	await expect(page.getByText("Hi! What can I do for you?")).toBeVisible();
	await say(page, "plan my trip");
	await expect(page.locator(".message-assistant").last()).toHaveText("Echo: plan my trip");
	await page.getByRole("button", { name: "New conversation" }).click();
	await expect(page.getByText("Hi! What can I do for you?")).toBeVisible();
	await page.getByRole("button", { name: "Conversations" }).click();
	await page
		.getByRole("navigation", { name: "Earlier conversations" })
		.getByRole("button", { name: /plan my trip/ })
		.click();
	await expect(page.locator(".message-assistant").last()).toHaveText("Echo: plan my trip");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("plan my trip");
});

test("offers to continue after the assistant was interrupted", async ({ page }) => {
	await open(page);
	await say(page, "crash");
	await expect(page.getByText("I was interrupted. Continue?")).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Continue" }).click();
	await expect(page.locator(".message-assistant").last()).toHaveText("Echo: Continue where you left off.");
	await expect(page.getByText("I was interrupted. Continue?")).toBeHidden();
});

test("keeps the conversation after a page reload", async ({ page }) => {
	await open(page);
	await say(page, "remember this");
	await expect(page.locator(".message-assistant").last()).toHaveText("Echo: remember this");
	await page.reload();
	await expect(page.locator(".message-assistant").last()).toHaveText("Echo: remember this");
});

test("explains a rejected access key", async ({ page }) => {
	await page.goto("/#token=wrong-token");
	await expect(page.getByRole("status")).toContainText("This link is not valid anymore");
});

test("asks for the printed link when there is no access key", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("Open the link the assistant printed");
});

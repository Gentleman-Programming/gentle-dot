import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { E2E_COMMANDS_FILE, E2E_DATA_DIR, E2E_TOKEN } from "./token.ts";

const readJson = (path: string) =>
	existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : undefined;
const agentCommands = () =>
	existsSync(E2E_COMMANDS_FILE)
		? readFileSync(E2E_COMMANDS_FILE, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as unknown)
		: [];

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

test("opens accounts with /login, offers subscriptions without Claude, and connects an API key", async ({
	page,
}) => {
	await open(page);
	await say(page, "/login");
	const accounts = page.getByRole("region", { name: "Accounts" });
	await expect(accounts).toBeVisible();
	const useSubscription = accounts.getByRole("button", { name: /^Use a subscription/ });
	const useApiKey = accounts.getByRole("button", { name: /^Use an API key/ });
	await expect(useSubscription).toBeVisible();
	await expect(useApiKey).toBeVisible();

	await useSubscription.click();
	const subscriptions = accounts.getByRole("region", { name: "Use a subscription" });
	await expect(subscriptions.getByRole("button", { name: /^Sign in with .*ChatGPT/ }).first()).toBeVisible();
	// A Claude subscription cannot be used from here, so it is never offered.
	await expect(accounts.getByRole("button", { name: /Claude Pro\/Max/ })).toHaveCount(0);
	await accounts.getByRole("button", { name: "Back", exact: true }).click();

	await useApiKey.click();
	const apiKeys = accounts.getByRole("region", { name: "Use an API key" });
	await accounts.getByRole("searchbox", { name: "Search providers" }).fill("OpenAI");
	await apiKeys.getByRole("button", { name: "Use an API key for OpenAI" }).click();
	const key = accounts.getByLabel("Enter OpenAI API key");
	await expect(key).toHaveAttribute("type", "password");
	await key.fill("sk-e2e-not-real");
	await accounts.getByRole("button", { name: "Continue" }).click();
	await expect(accounts.getByRole("status")).toHaveText("Connected to OpenAI.");
	// "Back to accounts" returns to the first step, which lists connected accounts.
	await accounts.getByRole("button", { name: "Back to accounts" }).click();
	const signOut = accounts
		.getByRole("region", { name: "Connected" })
		.getByRole("button", { name: "Sign out of OpenAI" });
	await expect(signOut).toBeVisible();
	await signOut.click();
	await expect(accounts.getByRole("button", { name: "Sign out of OpenAI" })).toHaveCount(0);
	await accounts.getByRole("button", { name: "Close accounts" }).click();
	await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("creates a profile with /profiles, edits a role, and switches to it", async ({ page }) => {
	await open(page);
	await say(page, "/profiles");
	const profiles = page.getByRole("region", { name: "Profiles" });
	await expect(profiles).toBeVisible();
	await expect(profiles.getByText("No profiles yet.")).toBeVisible();
	await expect(profiles.getByRole("button", { name: "Import my Gentle Shell profiles" })).toBeHidden();

	await profiles.getByRole("button", { name: "New profile" }).click();
	await profiles.getByRole("textbox", { name: "Profile name" }).fill("e2e-focus");
	await profiles.getByRole("combobox", { name: "Main assistant model" }).selectOption({ label: "Fake Fast" });
	await profiles.getByRole("button", { name: "Save" }).click();
	const item = profiles.getByRole("listitem").filter({ has: page.getByText("e2e-focus", { exact: true }) });
	await expect(item).toContainText("Main assistant: Fake Fast");

	await item.getByRole("button", { name: "Edit" }).click();
	await profiles.getByRole("combobox", { name: "Main assistant thinking" }).selectOption("high");
	await profiles.getByRole("button", { name: "Save" }).click();
	await expect(item).toContainText("Main assistant: Fake Fast · High");

	expect(agentCommands()).toEqual([]);
	await item.getByRole("button", { name: "Use" }).click();
	await expect(item.getByText("In use")).toBeVisible();
	await expect(item.getByRole("button", { name: "Use" })).toBeHidden();

	const roles = { orchestrator: { model: "fake/fake-fast", thinking: "high" } };
	expect(readJson(join(E2E_DATA_DIR, "gentle-ai", "profiles.json"))).toEqual({
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		profiles: { "e2e-focus": roles },
		active: "e2e-focus",
	});
	expect(readJson(join(E2E_DATA_DIR, "gentle-ai", "models.json"))).toEqual(roles);
	expect(readJson(join(E2E_DATA_DIR, "agent", "settings.json"))).toEqual({
		defaultProvider: "fake",
		defaultModel: "fake-fast",
		defaultThinkingLevel: "high",
	});
	await expect.poll(agentCommands).toEqual([
		{ type: "set_model", provider: "fake", modelId: "fake-fast", busy: false },
		{ type: "set_thinking_level", level: "high", busy: false },
	]);

	await profiles.getByRole("button", { name: "Close profiles" }).click();
	await page.getByRole("button", { name: "Profiles" }).click();
	await expect(page.getByRole("region", { name: "Profiles" }).getByText("In use")).toBeVisible();
});

test("explains a rejected access key", async ({ page }) => {
	await page.goto("/#token=wrong-token");
	await expect(page.getByRole("status")).toContainText("This access key is not valid anymore");
});

test("asks for the access key when there is none", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("This page needs your access key");
});

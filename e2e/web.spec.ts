import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	E2E_COMMANDS_FILE,
	E2E_CONVERSATIONS_PORT,
	E2E_DATA_DIR,
	E2E_IMPORT_HOME,
	E2E_TOKEN,
} from "./token.ts";

const readJson = (path: string) =>
	existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : undefined;
const agentCommands = () =>
	existsSync(E2E_COMMANDS_FILE)
		? readFileSync(E2E_COMMANDS_FILE, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as unknown)
		: [];

/** The daemon with the conversations list on; the default one keeps a single chat. */
const WITH_CONVERSATIONS = `http://127.0.0.1:${E2E_CONVERSATIONS_PORT}`;

async function open(page: Page, base = "") {
	await page.goto(`${base}/#token=${E2E_TOKEN}`);
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
	await open(page, WITH_CONVERSATIONS);
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

test("shows a message sent while the assistant works as queued, then delivers it", async ({ page }) => {
	await open(page);
	await say(page, "slow");
	await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
	await say(page, "queued one");
	const queued = page.getByRole("article", { name: "Queued message" });
	await expect(queued).toHaveCount(1);
	await expect(queued).toContainText("Queued");
	await expect(queued.locator(".message-body")).toHaveText("queued one");
	await expect(page.locator(".message-assistant").last()).toHaveText("Echo: queued one", { timeout: 10_000 });
	await expect(queued).toHaveCount(0);
	// One continuous chat: the earlier tests' messages are above these.
	const lastTwo = async (selector: string) => (await page.locator(selector).allTextContents()).slice(-2);
	await expect.poll(() => lastTwo(".message-user")).toEqual(["slow", "queued one"]);
	await expect.poll(() => lastTwo(".message-assistant")).toEqual(["Echo: slow", "Echo: queued one"]);
});

test("asks before leaving a running answer, then opens the other conversation with no error", async ({
	page,
}) => {
	await open(page, WITH_CONVERSATIONS);
	await page.getByRole("button", { name: "New conversation" }).click();
	await expect(page.getByText("Hi! What can I do for you?")).toBeVisible();
	await say(page, "first chat");
	await expect(page.locator(".message-assistant").last()).toHaveText("Echo: first chat");
	await page.getByRole("button", { name: "New conversation" }).click();
	await expect(page.getByText("Hi! What can I do for you?")).toBeVisible();
	await say(page, "hang");
	await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

	await page.getByRole("button", { name: "Conversations" }).click();
	await page
		.getByRole("navigation", { name: "Earlier conversations" })
		.getByRole("button", { name: /first chat/ })
		.click();
	const dialog = page.getByRole("alertdialog", { name: "Stop and switch?" });
	await expect(dialog).toContainText(
		"The assistant is still answering. Stop it and open the other conversation?",
	);
	await dialog.getByRole("button", { name: "Stop and switch" }).click();

	await expect(page.getByRole("heading", { level: 1 })).toHaveText("first chat");
	await expect(page.locator(".message-user")).toHaveText(["first chat"]);
	await expect(page.locator(".message-assistant")).toHaveText(["Echo: first chat"]);
	await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
	await expect(dialog).toBeHidden();
	await expect(page.locator(".notice")).toHaveCount(0);
	await expect(page.locator(".message-note-error")).toHaveCount(0);
});

test("closes open options when the user starts typing, with titled header icons", async ({ page }) => {
	await open(page);
	for (const name of ["Accounts", "Profiles"]) {
		await expect(page.getByRole("button", { name })).toHaveAttribute("title", name);
	}
	await page.getByRole("button", { name: "Profiles" }).click();
	await expect(page.getByRole("region", { name: "Profiles" })).toBeVisible();
	await page.getByRole("textbox", { name: "Message" }).pressSequentially("h");
	await expect(page.getByRole("region", { name: "Profiles" })).toBeHidden();
	await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("h");
});

test("keeps one continuous chat: the header shows the assistant, with no conversations", async ({ page }) => {
	await open(page);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Gentle Dot");
	await expect(page.getByRole("button", { name: "New conversation" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Conversations" })).toHaveCount(0);
});

test("crosses a session rotation without a seam, and shows earlier messages on request", async ({ page }) => {
	await open(page);
	await say(page, "rotation alpha");
	await expect(page.locator(".message-assistant").last()).toHaveText("Echo: rotation alpha");
	await say(page, "compact");
	await expect(page.locator(".message-assistant").last()).toHaveText("Compacted.");
	await say(page, "compact");
	// The second compaction rotates the session (GENTLE_DOT_ROTATE_COMPACTIONS=2 in serve.ts).
	const divider = page.locator(".earlier-divider");
	await expect(divider).toHaveText("Earlier messages");
	await say(page, "recall");
	// The new session knows the earlier one through the hidden handoff, which never shows as a message.
	await expect(page.locator(".message-assistant").last()).toContainText("Summary: ");
	await expect(page.locator(".message-assistant").last()).toContainText("rotation alpha");
	await expect(page.locator(".message-user").last()).toHaveText("recall");

	// Only the latest page (4 messages, GENTLE_DOT_HISTORY_PAGE=4) loads after a reload.
	await page.reload();
	await expect(page.locator(".message-assistant").last()).toContainText("Recall: ");
	await expect(divider).toBeVisible();
	const alpha = page.locator(".message-user", { hasText: /^rotation alpha$/ });
	await expect(alpha).toHaveCount(0);
	await page.getByRole("button", { name: "Show earlier" }).click();
	await expect(alpha).toHaveCount(1);
	await expect(page.locator(".earlier-divider")).toHaveCount(1);
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

test("connects Notion from the Connectors screen, switches its mode, and removes it", async ({ page }) => {
	// The sign-in page would open in a new tab; keep its address instead.
	await page.addInitScript(() => {
		const opened: string[] = [];
		(window as unknown as { opened: string[] }).opened = opened;
		window.open = (url?: string | URL) => {
			opened.push(String(url));
			return null;
		};
	});
	await open(page);
	await page.getByRole("button", { name: "Connectors" }).click();
	const screen = page.getByRole("region", { name: "Connectors" });
	for (const name of ["Notion", "Linear", "Atlassian"]) {
		await expect(screen.getByRole("listitem", { name })).toBeVisible();
	}
	const notion = screen.getByRole("listitem", { name: "Notion" });
	await expect(notion).toContainText("It cannot send or change anything.");
	await notion.getByRole("button", { name: "Connect Notion" }).click();

	await expect(screen).toContainText("Signing in to Notion");
	await screen.getByRole("button", { name: "Open the sign-in page" }).click();
	const link = await page.evaluate(() => (window as unknown as { opened: string[] }).opened[0] ?? "");
	expect(link).toMatch(/^https:\/\/auth\.example\.com\/authorize\?/);
	await page.screenshot({ path: "/tmp/gentle-dot-t18a/connectors-signin.png" });
	// The browser could not reach this computer: paste the address it ended on.
	const redirect = new URL(new URL(link).searchParams.get("redirect_uri") ?? "");
	redirect.search = "?code=e2e-code&state=fake-state";
	await screen.getByLabel(/paste it here/).fill(redirect.href);
	await screen.getByRole("button", { name: "Continue" }).click();
	await expect(screen.getByRole("status")).toHaveText("Connected to Notion.");
	await screen.getByRole("button", { name: "Back to connectors" }).click();

	await expect(notion.getByText("Connected", { exact: true })).toBeVisible();
	await expect(notion.getByRole("radio", { name: "Read only" })).toBeChecked();
	// The choice is the daemon's: the radio follows the list it sends back.
	await notion.getByRole("radio", { name: "Read and send" }).click();
	await expect(notion.getByRole("radio", { name: "Read and send" })).toBeChecked();
	await expect(notion).toContainText("after you approve each one");
	await page.screenshot({ path: "/tmp/gentle-dot-t18a/connectors-screen.png" });
	const mcp = JSON.parse(readFileSync(join(E2E_DATA_DIR, "agent", "mcp.json"), "utf8"));
	expect(mcp).toEqual({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp", exposure: "direct" } } });

	await notion.getByRole("button", { name: "Remove Notion" }).click();
	await expect(notion.getByRole("button", { name: "Connect Notion" })).toBeVisible();
	await expect(notion.getByText("Connected", { exact: true })).toHaveCount(0);
	expect(JSON.parse(readFileSync(join(E2E_DATA_DIR, "agent", "mcp.json"), "utf8"))).toEqual({
		mcpServers: {},
	});
	await screen.getByRole("button", { name: "Close connectors" }).click();

	// Typing /connectors opens the screen; it never reaches the assistant.
	const sent = await page.locator(".message-user").count();
	await say(page, "/connectors");
	await expect(screen).toBeVisible();
	await expect(page.locator(".message-user")).toHaveCount(sent);
});

/** Every file below `dir` with its hash, to show a scan never changes them. */
function hashes(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) Object.assign(out, hashes(path));
		else out[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
	}
	return out;
}

test("sets up Discord from its guide, imports a found server, and adds the assistant's draft", async ({
	page,
}) => {
	const shots = "/tmp/gentle-dot-t18b";
	const before = hashes(E2E_IMPORT_HOME);
	const mcpServers = () =>
		(
			JSON.parse(readFileSync(join(E2E_DATA_DIR, "agent", "mcp.json"), "utf8")) as {
				mcpServers: Record<string, Record<string, unknown>>;
			}
		).mcpServers;
	await open(page);
	await page.getByRole("button", { name: "Connectors" }).click();
	const screen = page.getByRole("region", { name: "Connectors" });

	// Guides: Slack and Gmail show the redirect address to register; Discord asks for the bot token.
	for (const name of ["Slack", "Gmail"]) {
		await screen.getByRole("button", { name: `Connect ${name}` }).click();
		const guide = screen.getByRole("region", { name: `Set up ${name}` });
		await expect(guide).toContainText("http://localhost:3841");
		await page.screenshot({ path: `${shots}/guide-${name.toLowerCase()}.png` });
		await guide.getByRole("button", { name: "Back" }).click();
	}
	await screen.getByRole("button", { name: "Connect Discord" }).click();
	const guide = screen.getByRole("region", { name: "Set up Discord" });
	await expect(guide).toContainText("Message Content Intent");
	await page.screenshot({ path: `${shots}/guide-discord.png` });
	await guide.getByRole("button", { name: "Continue" }).click();
	await expect(screen).toContainText("Setting up Discord");
	await screen.getByLabel(/bot token/i).fill("dummy-discord-token");
	await screen.getByRole("button", { name: "Continue" }).click();
	await expect(screen.getByRole("status")).toHaveText("Connected to Discord.");
	await screen.getByRole("button", { name: "Back to connectors" }).click();
	expect(mcpServers().discord).toMatchObject({ command: "npx", args: ["-y", "@pasympa/discord-mcp@2.2.0"] });
	await expect(page.locator("body")).not.toContainText("dummy-discord-token");

	// Import: names only, with the source app; the old SSE server cannot be imported.
	await screen.getByRole("button", { name: "Import my MCP servers" }).click();
	const found = screen.getByRole("region", { name: "Found these servers" });
	await expect(found.getByRole("checkbox", { name: "github" })).toBeVisible();
	await expect(found).toContainText("From Cursor");
	await expect(found).toContainText("GITHUB_PERSONAL_ACCESS_TOKEN");
	await expect(found.getByRole("checkbox", { name: "oldsse" })).toBeDisabled();
	await expect(page.locator("body")).not.toContainText("ghp_e2e_secret_value");
	await page.screenshot({ path: `${shots}/import-list.png` });
	await found.getByRole("checkbox", { name: "github" }).check();
	await found.getByRole("checkbox", { name: "search" }).check();
	await found.getByRole("button", { name: "Import 2 servers" }).click();
	const github = screen.getByRole("listitem", { name: "github" });
	await expect(github).toContainText("Imported from Cursor");
	await expect(github).toContainText("tools stay hidden");
	await expect(screen.getByRole("listitem", { name: "search" })).toContainText("Needs setup");
	expect(mcpServers().github).toMatchObject({ toolExposure: { "*": "hidden" } });
	expect(hashes(E2E_IMPORT_HOME)).toEqual(before);

	// Add another: the request goes to the chat; the assistant's draft comes back as a card.
	await screen.getByRole("button", { name: "Add another connector" }).click();
	await screen.getByLabel("What do you want to connect?").fill("Weather");
	await page.screenshot({ path: `${shots}/add-another.png` });
	await screen.getByRole("button", { name: "Ask the assistant" }).click();
	await expect(page.locator(".message-user").last()).toContainText("Weather");
	const draft = {
		name: "Weather",
		description: "Look up forecasts.",
		transport: "stdio",
		command: "npx",
		args: ["-y", "weather-mcp@1.0.0"],
		env_names: ["WEATHER_API_KEY"],
	};
	await say(page, `propose:${JSON.stringify(draft)}`);
	const card = page.getByRole("region", { name: "Add Weather?" });
	await expect(card).toContainText("npx -y weather-mcp@1.0.0");
	await expect(card).toContainText("WEATHER_API_KEY");
	await card.scrollIntoViewIfNeeded();
	await card.screenshot({ path: `${shots}/draft-card.png` });
	await page.screenshot({ path: `${shots}/draft-card-panel.png` });
	await card.getByRole("button", { name: "Add Weather" }).click();
	await expect(screen).toContainText("Setting up Weather");
	await screen.getByLabel(/WEATHER_API_KEY/).fill("weather-secret-value");
	await screen.getByRole("button", { name: "Continue" }).click();
	await expect(screen.getByRole("status")).toHaveText("Connected to Weather.");
	expect(mcpServers().weather).toMatchObject({ command: "npx", toolExposure: { "*": "hidden" } });
	await expect(page.locator("body")).not.toContainText("weather-secret-value");
	await screen.getByRole("button", { name: "Back to connectors" }).click();
	for (const name of ["github", "Weather"]) {
		const row = screen.getByRole("listitem", { name });
		await row.scrollIntoViewIfNeeded();
		await row.screenshot({ path: `${shots}/connector-row-${name.toLowerCase()}.png` });
	}
	for (const name of ["Discord", "github", "search", "Weather"]) {
		await screen.getByRole("button", { name: `Remove ${name}` }).click();
		await expect(screen.getByRole("button", { name: `Remove ${name}` })).toHaveCount(0);
	}
});

test("shows a connector action as an approval card with a preview", async ({ page }) => {
	await open(page);
	await say(page, "ask:approval");
	const card = page.getByRole("region", { name: "The assistant needs your answer" });
	await expect(card).toContainText("Allow Notion to create pages?");
	await expect(card).toContainText("parent: Team notes");
	await expect(card).toContainText("title: Weekly plan");
	await expect(card.locator(".ask-message")).toHaveCSS("white-space", "pre-wrap");
	await expect(card.locator(".ask-message")).toHaveCSS("overflow-y", "auto");
	await card.screenshot({ path: "/tmp/gentle-dot-t18a/approval-card.png" });
	await page.screenshot({ path: "/tmp/gentle-dot-t18a/approval-card-panel.png" });
	await card.getByRole("button", { name: "No" }).click();
	await expect(card).toBeHidden();
	await expect(page.locator(".message-assistant").last()).toHaveText("I did not create the page");
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

test("keeps the onboarding banner in its own space, above the first message", async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 300 });
	await open(page);
	for (const text of ["one", "two", "three"]) {
		await say(page, text);
		await expect(page.locator(".message-assistant").last()).toHaveText(`Echo: ${text}`);
	}
	const banner = page.locator(".onboarding");
	await expect(banner).toBeVisible();
	await page.screenshot({ path: "test-results/onboarding-banner.png" });
	const top = await banner.boundingBox();
	const first = await page.locator(".message").first().boundingBox();
	expect(top && first && top.y + top.height <= first.y).toBe(true);
});

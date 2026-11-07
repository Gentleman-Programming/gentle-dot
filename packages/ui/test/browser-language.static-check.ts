import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { APP_REQUIRED, type ClientMessage, type ServerPayload } from "@gentle-dot/protocol";
import { type Browser, chromium, expect } from "@playwright/test";
import { preview } from "vite";
import { messages, type UiLocale } from "../src/i18n-messages.ts";

/** Standalone built-UI check: no Playwright config, daemon, credentials or real transport. */
async function main() {
	const root = fileURLToPath(new URL("../", import.meta.url));
	await access(new URL("../dist/app/index.html", import.meta.url));
	const server = await preview({
		root,
		configFile: false,
		logLevel: "silent",
		build: { outDir: "dist/app" },
		preview: { host: "127.0.0.1", port: 0, strictPort: true },
	});
	let browser: Browser | undefined;
	try {
		const address = server.httpServer.address();
		assert(address && typeof address !== "string");
		const origin = `http://127.0.0.1:${address.port}`;
		browser = await chromium.launch({
			executablePath: "/usr/bin/google-chrome",
			chromiumSandbox: true,
			headless: true,
			timeout: 10_000,
		});
		console.log(`STATIC_UI_BROWSER ${browser.version()}: sandbox=true, headless=true`);
		for (const locale of ["en", "es"] as const) {
			const copy = messages[locale];
			const context = await browser.newContext({ serviceWorkers: "block" });
			try {
				// This fresh test context contains only synthetic preferences and token data.
				await context.addInitScript((language: UiLocale) => {
					localStorage.setItem("gentle-dot-ui-language", language);
				}, locale);
				await context.route("**/*", (route) =>
					new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
				);
				const page = await context.newPage();
				page.setDefaultTimeout(5_000);
				const errors: string[] = [];
				page.on("pageerror", (error) => errors.push(error.message));
				const sent: ClientMessage[] = [];
				// Never call connectToServer: every WebSocket is synthetic, even if a built origin differs.
				await page.routeWebSocket(/.*/, (socket) => {
					let seq = 0;
					const reply = (payload: ServerPayload) => socket.send(JSON.stringify({ ...payload, seq: ++seq }));
					socket.onMessage((raw) => {
						const message = JSON.parse(String(raw)) as ClientMessage;
						sent.push(message);
						switch (message.type) {
							case "hello":
								assert.equal(message.token, "synthetic-browser-token");
								reply({
									type: "ready",
									agentState: "idle",
									conversationId: "fixture",
									features: { conversations: true },
								});
								break;
							case "get_history":
								reply({
									type: "history",
									conversationId: "fixture",
									messages: [
										{ id: "user-fixture", role: "user", text: "User text stays Original", activities: [] },
										{
											id: "assistant-fixture",
											role: "assistant",
											text: "Assistant text stays Original",
											activities: [],
										},
									],
								});
								reply({ type: "interrupted" });
								break;
							case "list_conversations":
								reply({
									type: "conversations",
									activeId: "fixture",
									conversations: [
										{ id: "fixture", title: "New conversation", updatedAt: "2026-01-01T00:00:00Z" },
									],
								});
								break;
							case "models_list":
							case "model_set":
								reply({
									type: "models",
									groups: [
										{
											provider: "fixture-provider",
											name: "Fixture Provider",
											models: [
												{
													provider: "fixture-provider",
													id: "fixture-model",
													name: "Fixture model",
													images: false,
													thinkingLevels: ["off", "low", "high"],
												},
											],
										},
									],
									profiles: [],
									current: {
										provider: "fixture-provider",
										id: "fixture-model",
										name: "Fixture model",
										thinking: message.type === "model_set" ? (message.thinking ?? "off") : "off",
									},
								});
								break;
							case "profiles_list":
								reply({
									type: "profiles",
									active: "active",
									importable: true,
									profiles: [
										{
											name: "Default",
											roles: {
												main: { model: "lost/model", thinking: "high" },
												hidden: { model: "x/y" },
											},
										},
										{ name: "active", roles: {} },
									],
									roles: [{ id: "main", label: "Default" }],
									models: [{ provider: "p", id: "m", name: "Default", reasoning: true }],
								});
								break;
							case "connectors_list":
								reply({
									type: "connectors",
									connectors: [
										{
											id: "raw-id",
											name: "Connected",
											reads: "Read only",
											sends: "Sign-in did not finish.",
											added: true,
											enabled: true,
											mode: "read_write",
											status: "connected",
											custom: { origin: "Off", summary: "Needs setup" },
										},
									],
								});
								break;
							case "connectors_scan":
								reply({
									type: "connector_imports",
									found: [
										{
											id: "candidate",
											name: "candidate",
											sources: ["Connected"],
											transport: "http",
											summary: "https://example.test/mcp",
											envNames: ["KEY"],
											headerNames: [],
											inputs: ["INPUT"],
											importable: true,
											notes: ["Read only"],
										},
									],
								});
								break;
							case "profile_import":
								reply({
									type: "profiles_imported",
									imported: [{ from: "Default", to: "Default-copy" }],
									missingProviders: ["Fixture Provider"],
								});
								break;
							case "auth_list":
								reply({
									type: "auth_providers",
									providers: [
										{
											id: "fixture-provider",
											name: "Fixture Provider",
											oauthName: "Fixture plan",
											methods: ["oauth"],
											configured: true,
											source: "stored",
										},
									],
								});
								break;
						}
					});
				});
				await page.goto(`${origin}/#token=synthetic-browser-token`);
				await expect(page.getByRole("button", { name: copy.chatAccounts, exact: true })).toBeVisible();
				await expect(page.getByRole("heading", { level: 1 })).toHaveText("New conversation");
				await expect(page.getByText("User text stays Original", { exact: true })).toBeVisible();
				await expect(page.getByText("Assistant text stays Original", { exact: true })).toBeVisible();
				assert(!page.url().includes("token"));
				await page.getByRole("button", { name: copy.chatAccounts, exact: true }).click();
				await expect(page.getByRole("heading", { name: copy["account.title"], exact: true })).toBeVisible();
				await page.getByRole("button", { name: copy["account.subscription"] }).click();
				await expect(page.getByRole("searchbox", { name: copy["account.search"] })).toBeVisible();
				await page
					.getByRole("button", {
						name: copy["account.signInLabel"].replace("{provider}", "Fixture plan"),
						exact: true,
					})
					.click();
				await expect
					.poll(() => sent.filter((message) => message.type === "auth_login"))
					.toEqual([{ type: "auth_login", providerId: "fixture-provider", method: "oauth" }]);
				await page.getByRole("button", { name: copy["account.close"], exact: true }).click();
				await page.getByRole("button", { name: copy.chatContinue, exact: true }).click();
				await expect.poll(() => sent.filter((message) => message.type === "send")).toHaveLength(1);
				const [continuation] = sent.filter((message) => message.type === "send");
				assert(continuation);
				assert.equal(continuation.text, "Continue where you left off.");
				assert.deepEqual(Object.keys(continuation).sort(), ["requestId", "text", "type"]);
				assert(continuation.requestId);
				const draft = "Browser User Original ¿sí? $&";
				const composer = page.getByRole("textbox", { name: copy.composerMessage, exact: true });
				await expect(composer).toHaveAttribute("placeholder", copy.composerIdlePlaceholder);
				await composer.fill(draft);
				await page.getByRole("button", { name: copy.composerSend, exact: true }).click();
				await expect.poll(() => sent.filter((message) => message.type === "send")).toHaveLength(2);
				const submitted = sent.filter((message) => message.type === "send")[1];
				assert.equal(submitted?.text, draft);
				assert(submitted?.requestId);
				await expect(composer).toHaveValue("");
				await page.getByTitle(copy["model.change"], { exact: true }).click();
				const picker = page.getByRole("dialog", { name: copy["model.choose"], exact: true });
				await expect(picker.getByRole("searchbox", { name: copy["model.search"] })).toBeVisible();
				await picker.getByRole("option", { name: /Fixture model/ }).click();
				await expect
					.poll(() => sent.filter((message) => message.type === "model_set"))
					.toEqual([
						{ type: "model_set", provider: "fixture-provider", id: "fixture-model", thinking: "off" },
					]);
				await page.getByTitle(copy["model.change"], { exact: true }).click();
				const thinking = picker.getByRole("combobox", { name: copy["model.thinking"] });
				await expect(
					thinking.getByRole("option", { name: copy["model.thinking.high"], exact: true }),
				).toHaveAttribute("value", "high");
				await thinking.selectOption("high");
				await expect
					.poll(() => sent.filter((message) => message.type === "model_set"))
					.toEqual([
						{ type: "model_set", provider: "fixture-provider", id: "fixture-model", thinking: "off" },
						{ type: "model_set", provider: "fixture-provider", id: "fixture-model", thinking: "high" },
					]);
				await expect(thinking).toHaveValue("high");
				// Continue through the real web entrypoint, not a separate component harness.
				await page.keyboard.press("Escape");
				await page.getByRole("button", { name: copy.chatProfiles, exact: true }).click();
				const profiles = page.getByRole("region", { name: copy["profile.title"], exact: true });
				await expect(profiles).toBeVisible();
				const profile = profiles
					.getByRole("listitem")
					.filter({ has: page.getByText("Default", { exact: true }) });
				await expect(
					profile.getByText(`Default: lost/model · ${copy["profile.thinking.high"]}`, { exact: true }),
				).toBeVisible();
				const active = profiles
					.getByRole("listitem")
					.filter({ has: page.getByText("active", { exact: true }) });
				await expect(
					active.getByRole("button", { name: copy["profile.delete"], exact: true }),
				).toBeDisabled();
				await expect(
					active.getByRole("button", { name: copy["profile.delete"], exact: true }),
				).toHaveAttribute("title", copy["profile.deleteGuard"]);
				await profile.getByRole("button", { name: copy["profile.edit"], exact: true }).click();
				const roleModel = profiles.getByRole("combobox", {
					name: copy["profile.modelLabel"].replace("{role}", "Default"),
					exact: true,
				});
				await expect(roleModel).toHaveValue("lost/model");
				await expect(
					roleModel.getByRole("option", {
						name: copy["profile.unavailable"].replace("{model}", "lost/model"),
						exact: true,
					}),
				).toHaveAttribute("value", "lost/model");
				await profiles.getByRole("button", { name: copy["profile.save"], exact: true }).click();
				await expect
					.poll(() => sent.filter((message) => message.type === "profile_save"))
					.toEqual([
						{
							type: "profile_save",
							name: "Default",
							roles: {
								main: { model: "lost/model", thinking: "high" },
								hidden: { model: "x/y" },
							},
						},
					]);
				await profile.getByRole("button", { name: copy["profile.duplicate"], exact: true }).click();
				await expect(
					profiles.getByRole("textbox", { name: copy["profile.duplicateLabel"], exact: true }),
				).toHaveValue("Default-copy");
				await profiles.getByRole("button", { name: copy["profile.duplicate"], exact: true }).click();
				await expect
					.poll(() => sent.filter((message) => message.type === "profile_duplicate"))
					.toEqual([{ type: "profile_duplicate", from: "Default", to: "Default-copy" }]);
				await profiles.getByRole("button", { name: copy["profile.import"], exact: true }).click();
				await expect(profiles.getByRole("status")).toContainText("Default → Default-copy");
				await expect(profiles.getByRole("status")).toContainText("Fixture Provider");
				await profiles.getByRole("button", { name: copy["profile.close"], exact: true }).click();
				await page.getByRole("button", { name: copy.chatConnectors, exact: true }).click();
				const connectors = page.getByRole("region", { name: copy["connector.title"], exact: true });
				await expect(connectors).toBeVisible();
				await expect(connectors.getByText(APP_REQUIRED, { exact: true })).toBeVisible();
				const row = connectors.getByRole("listitem", { name: "Connected", exact: true });
				for (const text of ["Read only", "Sign-in did not finish."]) {
					await expect(row.locator("p").getByText(text, { exact: true })).toBeVisible();
				}
				await expect(row.locator("span").getByText("Off", { exact: true })).toBeVisible();
				await expect(row.locator("code").getByText("Needs setup", { exact: true })).toBeVisible();
				await expect(row.locator(".chip")).toHaveText(copy["connector.connected"]);
				await expect(
					row.getByRole("radio", { name: copy["connector.readWrite"], exact: true }),
				).toBeChecked();
				await expect(
					row.getByRole("radio", { name: copy["connector.readOnly"], exact: true }),
				).toBeDisabled();
				for (const name of [
					copy["connector.signinAgainLabel"].replace("{name}", "Connected"),
					`${copy["connector.disconnect"]} Connected`,
					`${copy["connector.remove"]} Connected`,
				]) {
					await expect(row.getByRole("button", { name, exact: true })).toBeDisabled();
				}
				await connectors.getByRole("button", { name: copy["connector.scan"], exact: true }).click();
				const imports = connectors.getByRole("region", { name: copy["connector.found"], exact: true });
				await expect(imports.getByText("https://example.test/mcp", { exact: true })).toBeVisible();
				await expect(imports.getByText("KEY", { exact: true })).toBeVisible();
				await expect(imports.getByText("INPUT", { exact: true })).toBeVisible();
				await imports.getByRole("checkbox", { name: "candidate", exact: true }).check();
				await expect(
					imports.getByRole("button", {
						name: `${copy["connector.import"]} 1 ${copy["connector.server"]}`,
						exact: true,
					}),
				).toBeDisabled();
				await imports.getByRole("button", { name: copy["connector.closeList"], exact: true }).click();
				await connectors.getByRole("button", { name: copy["connector.add"], exact: true }).click();
				await expect(
					connectors.getByRole("button", { name: copy["connector.ask"], exact: true }),
				).toBeDisabled();
				await connectors
					.getByRole("textbox", { name: copy["connector.question"], exact: true })
					.fill("  Jira Cloud  ");
				await connectors.getByRole("button", { name: copy["connector.ask"], exact: true }).click();
				await expect.poll(() => sent.filter((message) => message.type === "send")).toHaveLength(3);
				assert.deepEqual(sent.filter((message) => message.type === "send")[2], {
					type: "send",
					text: "Please help me add a connector for Jira Cloud. Find its MCP server and draft it for me to review.",
				});
				assert.equal(
					sent.filter((message) =>
						[
							"connector_mode",
							"connector_import",
							"connector_signin",
							"connector_remove",
							"connector_disconnect",
						].includes(message.type),
					).length,
					0,
				);
				assert.deepEqual(errors, []);
				console.log(
					`STATIC_UI_LANGUAGE_PASS ${locale}: navigation, accounts, composer, models, profiles, connector management/import/add, accessible guards, unchanged data and exact payloads`,
				);
			} finally {
				await context.close();
			}
		}
	} finally {
		await browser?.close();
		await new Promise<void>((resolve, reject) =>
			server.httpServer.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

await main();

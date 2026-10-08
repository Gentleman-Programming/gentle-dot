import type { ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatSurface } from "../src/components/ChatSurface.tsx";
import { ProfilesPanel } from "../src/components/ProfilesPanel.tsx";
import { type DotState, initialState, reduce } from "../src/store.ts";

const roles = [
	{ id: "orchestrator", label: "Main assistant" },
	{ id: "gentle-ai-worker", label: "Builder" },
];
const models = [
	{ provider: "fake", id: "fake-model", name: "Fake Model", reasoning: true },
	{ provider: "fake", id: "fake-fast", name: "Fake Fast", reasoning: false },
	{ provider: "other", id: "big", name: "Other Big", reasoning: true },
];
const profilesPayload: ServerPayload = {
	type: "profiles",
	profiles: [
		{
			name: "deep",
			roles: {
				orchestrator: { model: "fake/fake-model", thinking: "high" },
				"custom-agent": { model: "x/y" },
			},
		},
		{ name: "quick", roles: { orchestrator: { model: "fake/fake-fast" } } },
	],
	active: "quick",
	roles,
	models,
	importable: true,
};

function apply(state: DotState, ...payloads: ServerPayload[]): DotState {
	return payloads.reduce(
		(s, p) => reduce(s, { type: "server", message: { ...p, seq: 1 } as ServerMessage }),
		state,
	);
}

function base(): DotState {
	return apply({ ...initialState, connection: "open", agentState: "idle" }, profilesPayload);
}

function panel(state = base()) {
	const send = vi.fn();
	const dispatch = vi.fn();
	render(
		<ProfilesPanel
			profiles={state.profiles}
			providers={[{ id: "fake", name: "Fake Cloud", methods: ["api_key"], configured: true }]}
			send={send}
			dispatch={dispatch}
		/>,
	);
	return { send, dispatch };
}

const item = (name: string) =>
	screen.getAllByRole("listitem").find((li) => within(li).queryByText(name, { exact: true })) as HTMLElement;

describe("profiles state", () => {
	it("keeps the list, the profile in use, roles, models, and whether import is offered", () => {
		const s = base();
		expect(s.profiles).toEqual({
			open: false,
			list: (profilesPayload as { profiles: unknown }).profiles,
			active: "quick",
			roles,
			models,
			importable: true,
		});
	});

	it("opens on /profiles, closes accounts, and accounts close profiles in turn", () => {
		let s = reduce(base(), { type: "accounts", open: true });
		s = apply(s, { ...profilesPayload, open: true });
		expect([s.profiles.open, s.auth.open]).toEqual([true, false]);
		s = reduce(s, { type: "accounts", open: true });
		expect([s.profiles.open, s.auth.open]).toEqual([false, true]);
		s = reduce(s, { type: "profiles", open: true });
		expect([s.profiles.open, s.auth.open]).toEqual([true, false]);
	});

	it("drops the profile in use when the list has none", () => {
		const s = apply(base(), { ...profilesPayload, active: undefined });
		expect(s.profiles.active).toBeUndefined();
	});

	it("shows an import result until the screen closes", () => {
		let s = apply(base(), {
			type: "profiles_imported",
			imported: [{ from: "quick", to: "quick-imported" }],
			missingProviders: ["Anthropic"],
		});
		expect(s.profiles.lastImport).toEqual({
			imported: [{ from: "quick", to: "quick-imported" }],
			missingProviders: ["Anthropic"],
		});
		s = reduce(s, { type: "profiles", open: false });
		expect(s.profiles.lastImport).toBeUndefined();
	});
});

describe("ProfilesPanel", () => {
	it("lists profiles, marks the one in use, and switches with Use", async () => {
		const { send } = panel();
		expect(within(item("quick")).getByText("In use")).toBeInTheDocument();
		expect(within(item("quick")).queryByRole("button", { name: "Use" })).toBeNull();
		expect(within(item("quick")).getByRole("button", { name: "Delete" })).toBeDisabled();
		expect(within(item("deep")).getByText("Main assistant: Fake Model · High")).toBeInTheDocument();
		await userEvent.click(within(item("deep")).getByRole("button", { name: "Use" }));
		expect(send).toHaveBeenCalledWith({ type: "profile_apply", name: "deep" });
	});

	it("edits a profile per role with models grouped by provider and keeps routes it does not show", async () => {
		const { send } = panel();
		await userEvent.click(within(item("deep")).getByRole("button", { name: "Edit" }));
		const model = screen.getByRole("combobox", { name: "Builder model" });
		const groups = [...model.querySelectorAll("optgroup")].map((g) => g.label);
		expect(groups).toEqual(["Fake Cloud", "other"]);
		expect(within(model).getByRole("option", { name: "Default" })).toBeInTheDocument();
		await userEvent.selectOptions(model, "other/big");
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Builder thinking" }), "low");
		await userEvent.selectOptions(screen.getByRole("combobox", { name: "Main assistant thinking" }), "");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(send).toHaveBeenCalledWith({
			type: "profile_save",
			name: "deep",
			roles: {
				orchestrator: { model: "fake/fake-model" },
				"custom-agent": { model: "x/y" },
				"gentle-ai-worker": { model: "other/big", thinking: "low" },
			},
		});
		expect(screen.getByRole("list")).toBeInTheDocument();
	});

	it("keeps a model that is not available so saving does not lose it", async () => {
		const state = apply(base(), {
			...profilesPayload,
			profiles: [{ name: "gone", roles: { orchestrator: { model: "anthropic/opus" } } }],
		});
		panel(state);
		await userEvent.click(within(item("gone")).getByRole("button", { name: "Edit" }));
		expect(screen.getByRole("combobox", { name: "Main assistant model" })).toHaveValue("anthropic/opus");
		expect(screen.getByRole("option", { name: "anthropic/opus (not available)" })).toBeInTheDocument();
	});

	it("creates a new profile only with a valid, unused name", async () => {
		const { send } = panel();
		await userEvent.click(screen.getByRole("button", { name: "New profile" }));
		const name = screen.getByRole("textbox", { name: "Profile name" });
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();
		await userEvent.type(name, "has space");
		expect(save).toBeDisabled();
		expect(screen.getByText(/letters, numbers, dots, dashes, or underscores/)).toBeInTheDocument();
		await userEvent.clear(name);
		await userEvent.type(name, "quick");
		expect(screen.getByText("A profile with that name already exists.")).toBeInTheDocument();
		await userEvent.clear(name);
		await userEvent.type(name, "focus");
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "Main assistant model" }),
			"fake/fake-fast",
		);
		await userEvent.click(save);
		expect(send).toHaveBeenCalledWith({
			type: "profile_save",
			name: "focus",
			roles: { orchestrator: { model: "fake/fake-fast" } },
		});
	});

	it("duplicates and renames through a name form", async () => {
		const { send } = panel();
		await userEvent.click(within(item("deep")).getByRole("button", { name: "Duplicate" }));
		expect(screen.getByRole("textbox", { name: "Name for the copy" })).toHaveValue("deep-copy");
		await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
		expect(send).toHaveBeenCalledWith({ type: "profile_duplicate", from: "deep", to: "deep-copy" });

		await userEvent.click(within(item("deep")).getByRole("button", { name: "Rename" }));
		const name = screen.getByRole("textbox", { name: "New name" });
		await userEvent.clear(name);
		await userEvent.type(name, "deeper");
		await userEvent.click(screen.getByRole("button", { name: "Rename" }));
		expect(send).toHaveBeenLastCalledWith({ type: "profile_rename", from: "deep", to: "deeper" });
	});

	it("asks before deleting", async () => {
		const { send } = panel();
		await userEvent.click(within(item("deep")).getByRole("button", { name: "Delete" }));
		const confirm = screen.getByRole("alertdialog", { name: "Delete profile" });
		expect(confirm).toHaveTextContent("Delete “deep”? This cannot be undone.");
		await userEvent.click(within(confirm).getByRole("button", { name: "Keep it" }));
		expect(send).not.toHaveBeenCalled();
		await userEvent.click(within(item("deep")).getByRole("button", { name: "Delete" }));
		await userEvent.click(
			within(screen.getByRole("alertdialog", { name: "Delete profile" })).getByRole("button", {
				name: "Delete",
			}),
		);
		expect(send).toHaveBeenCalledWith({ type: "profile_delete", name: "deep" });
	});

	it("saves the current setup under a new name", async () => {
		const { send } = panel();
		await userEvent.click(screen.getByRole("button", { name: "Save my current setup" }));
		await userEvent.type(screen.getByRole("textbox", { name: "Name for your current setup" }), "today");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(send).toHaveBeenCalledWith({ type: "profile_save_current", name: "today" });
	});

	it("imports when offered and explains renames and accounts to connect", async () => {
		const { send, dispatch } = panel(
			apply(base(), {
				type: "profiles_imported",
				imported: [
					{ from: "quick", to: "quick-imported" },
					{ from: "solo", to: "solo" },
				],
				missingProviders: ["Anthropic"],
			}),
		);
		await userEvent.click(screen.getByRole("button", { name: "Import my Gentle Shell profiles" }));
		expect(send).toHaveBeenCalledWith({ type: "profile_import" });
		const result = screen.getByRole("status");
		expect(result).toHaveTextContent("Imported 2 profiles.");
		expect(result).toHaveTextContent("Renamed because the name was taken: quick → quick-imported.");
		expect(result).toHaveTextContent("Connect these accounts to use them: Anthropic.");
		await userEvent.click(within(result).getByRole("button", { name: "Open accounts" }));
		expect(send).toHaveBeenCalledWith({ type: "auth_list" });
		expect(dispatch).toHaveBeenCalledWith({ type: "accounts", open: true });
	});

	it("hides import when there is nothing to import", () => {
		panel(apply(base(), { ...profilesPayload, importable: false }));
		expect(screen.queryByRole("button", { name: "Import my Gentle Shell profiles" })).toBeNull();
	});

	it("closes", async () => {
		const { dispatch } = panel();
		await userEvent.click(screen.getByRole("button", { name: "Close profiles" }));
		expect(dispatch).toHaveBeenCalledWith({ type: "profiles", open: false });
	});
});

describe("ChatSurface profiles", () => {
	it("opens profiles from the header", async () => {
		const send = vi.fn();
		const dispatch = vi.fn();
		render(<ChatSurface variant="web" state={base()} send={send} dismiss={vi.fn()} dispatch={dispatch} />);
		await userEvent.click(screen.getByRole("button", { name: "Profiles" }));
		expect(send).toHaveBeenCalledWith({ type: "profiles_list" });
		expect(dispatch).toHaveBeenCalledWith({ type: "profiles", open: true });
	});

	it("shows the profiles screen instead of the chat while open", () => {
		const state = reduce(apply(base(), { type: "user_message", messageId: "u1", text: "earlier question" }), {
			type: "profiles",
			open: true,
		});
		render(<ChatSurface variant="web" state={state} send={vi.fn()} dismiss={vi.fn()} />);
		expect(screen.getByRole("region", { name: "Profiles" })).toBeInTheDocument();
		expect(screen.getByText("earlier question")).not.toBeVisible();
	});
});

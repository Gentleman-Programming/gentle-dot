import type { ModelChoice, ProfilePick, ThinkingLevel } from "@gentle-dot/protocol";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { DotAction, ModelsState } from "../store.ts";
import type { Send } from "./types.ts";

interface ModelPickerProps {
	/** The running model's name, as `ready` reports it, until the picker's list arrives. */
	model?: string;
	models: ModelsState;
	send: Send;
	dispatch: (action: DotAction) => void;
	disabled?: boolean;
}

type Item =
	| { kind: "model"; key: string; group: string; model: ModelChoice }
	| { kind: "profile"; key: string; pick: ProfilePick };

/** The models and profiles that match the search, in the order the list shows them. */
function visibleItems(models: ModelsState, query: string): Item[] {
	const q = query.trim().toLowerCase();
	const matches = (...texts: string[]) => q === "" || texts.some((t) => t.toLowerCase().includes(q));
	const items: Item[] = [];
	for (const group of models.groups ?? []) {
		for (const model of group.models) {
			if (matches(model.name, model.id, group.name))
				items.push({ kind: "model", key: `${model.provider}/${model.id}`, group: group.name, model });
		}
	}
	for (const pick of models.profiles) {
		if (matches(pick.name)) items.push({ kind: "profile", key: `profile:${pick.name}`, pick });
	}
	return items;
}

/**
 * The chat's model picker (S32): a chip with the running model that opens a searchable list of
 * the connected accounts' models and the saved profiles. Arrow keys move, Enter picks, and Esc
 * closes it without reaching the panel's own Esc (App.tsx).
 */
export function ModelPicker({ model, models, send, dispatch, disabled }: ModelPickerProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const chip = useRef<HTMLButtonElement>(null);
	const root = useRef<HTMLDivElement>(null);
	const id = useId();
	const items = open ? visibleItems(models, query) : [];
	const current = models.current;
	const currentKey = current ? `${current.provider}/${current.id}` : undefined;
	const shown = models.next?.name ?? current?.name ?? model;
	const thinking = current
		? models.groups
				?.flatMap((g) => g.models)
				.find((m) => m.provider === current.provider && m.id === current.id)?.thinkingLevels
		: undefined;

	// The highlight starts on the running model once the list arrives, not on every update.
	const loaded = models.groups !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the picker opens or its list arrives
	useEffect(() => {
		if (!open || !loaded) return;
		const index = visibleItems(models, "").findIndex((item) => item.key === currentKey);
		setActive(Math.max(index, 0));
	}, [open, loaded]);

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		return () => document.removeEventListener("pointerdown", onPointer);
	}, [open]);

	const close = () => {
		setOpen(false);
		chip.current?.focus();
	};

	const toggle = () => {
		if (open) {
			setOpen(false);
			return;
		}
		setQuery("");
		dispatch({ type: "models_opened" });
		send({ type: "models_list" });
		setOpen(true);
	};

	const choose = (item: Item | undefined) => {
		if (!item) return;
		if (item.kind === "profile") send({ type: "profile_apply", name: item.pick.name });
		else {
			const { provider, id: modelId, thinkingLevels } = item.model;
			// The thinking level carries over when the new model supports it.
			const level = current?.thinking;
			const keep = level !== undefined && thinkingLevels?.includes(level);
			send({ type: "model_set", provider, id: modelId, ...(keep ? { thinking: level } : {}) });
		}
		close();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			// Handled here, so the panel stays open (App.tsx checks defaultPrevented).
			event.preventDefault();
			close();
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (items.length === 0) return;
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((index) => (Math.min(index, items.length - 1) + step + items.length) % items.length);
		} else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
			event.preventDefault();
			choose(items[Math.min(active, items.length - 1)]);
		}
	};

	const optionId = (index: number) => `${id}-option-${index}`;
	const highlighted = Math.min(active, items.length - 1);
	const groups = [...new Set(items.filter((i) => i.kind === "model").map((i) => i.group))];
	const profiles = items.filter((i) => i.kind === "profile");
	const renderOption = (item: Item) => {
		const index = items.indexOf(item);
		const isCurrent =
			item.kind === "model" ? item.key === currentKey : item.pick.name === models.activeProfile;
		return (
			// biome-ignore lint/a11y/useKeyWithClickEvents: the search box drives the keyboard (aria-activedescendant)
			<div
				key={item.key}
				id={optionId(index)}
				role="option"
				tabIndex={-1}
				aria-selected={index === highlighted}
				aria-current={isCurrent ? "true" : undefined}
				className="model-option"
				onPointerMove={() => setActive(index)}
				onClick={() => choose(item)}
			>
				<span className="model-option-name">{item.kind === "model" ? item.model.name : item.pick.name}</span>
				{item.kind === "profile" && item.pick.model ? (
					<span className="model-option-detail">{item.pick.model}</span>
				) : null}
				{isCurrent ? <span className="model-option-detail">In use</span> : null}
			</div>
		);
	};
	const renderGroup = (label: string, members: Item[]) => (
		// biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group", not a fieldset
		<div key={label} role="group" aria-label={label} className="model-group">
			<p className="eyebrow" aria-hidden="true">
				{label}
			</p>
			{members.map(renderOption)}
		</div>
	);

	return (
		<div className="model-picker" ref={root}>
			<button
				ref={chip}
				type="button"
				className="model-chip"
				aria-label={`Model: ${shown ?? "not chosen"}`}
				title="Change the model"
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={disabled}
				onClick={toggle}
			>
				<span className="model-chip-name">{shown ?? "Choose a model"}</span>
				<span aria-hidden="true">▾</span>
			</button>
			{open ? (
				<div className="model-popover" role="dialog" aria-label="Choose a model" onKeyDown={onKeyDown}>
					<input
						type="search"
						className="model-search"
						aria-label="Search models"
						placeholder="Search models"
						aria-controls={`${id}-list`}
						aria-activedescendant={items.length > 0 ? optionId(highlighted) : undefined}
						// biome-ignore lint/a11y/noAutofocus: the popover opens for typing
						autoFocus
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setActive(0);
						}}
					/>
					{models.error ? (
						<p className="model-error" role="alert">
							{models.error}
						</p>
					) : null}
					{models.next ? (
						<p className="model-note">{models.next.name} is used from your next message.</p>
					) : null}
					{!loaded ? <p className="model-note">Loading models…</p> : null}
					{loaded && items.length === 0 ? <p className="model-note">No models match.</p> : null}
					<div className="model-list" id={`${id}-list`} role="listbox" aria-label="Models">
						{groups.map((group) =>
							renderGroup(
								group,
								items.filter((i) => i.kind === "model" && i.group === group),
							),
						)}
						{profiles.length > 0 ? renderGroup("Profiles", profiles) : null}
					</div>
					{current && thinking ? (
						<label className="model-thinking">
							<span>Thinking</span>
							<select
								aria-label="Thinking"
								value={current.thinking ?? ""}
								onChange={(event) =>
									send({
										type: "model_set",
										provider: current.provider,
										id: current.id,
										thinking: event.target.value as ThinkingLevel,
									})
								}
							>
								{thinking.map((level) => (
									<option key={level} value={level}>
										{level}
									</option>
								))}
							</select>
						</label>
					) : null}
				</div>
			) : null}
		</div>
	);
}

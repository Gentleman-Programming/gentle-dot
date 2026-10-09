import {
	type AuthProvider,
	isValidProfileName,
	type ModelOption,
	type Profile,
	type ProfileRole,
	type ProfileRoles,
	type RoleRoute,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "@gentle-dot/protocol";
import { type FormEvent, useState } from "react";
import type { DotAction, ProfilesState } from "../store.ts";
import type { Send } from "./types.ts";
import "../profiles.css";

interface ProfilesPanelProps {
	profiles: ProfilesState;
	/** Account names, used to label model groups. */
	providers?: AuthProvider[];
	send: Send;
	dispatch: (action: DotAction) => void;
}

type Mode =
	| { kind: "list" }
	| { kind: "edit"; profile?: Profile }
	| { kind: "name"; action: "rename" | "duplicate" | "save_current"; from?: string }
	| { kind: "delete"; name: string };

const THINKING_LABELS: Record<ThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

const NAME_HINT =
	"Use letters, numbers, dots, dashes, or underscores (up to 64), starting with a letter or number.";

/** Names a profile, or explains why the name cannot be used. */
function nameProblem(name: string, taken: string[]): string | undefined {
	if (!name) return undefined;
	if (!isValidProfileName(name)) return NAME_HINT;
	if (taken.includes(name)) return "A profile with that name already exists.";
	return undefined;
}

/** Profiles pick the model each part of the assistant uses; managed here without a terminal. */
export function ProfilesPanel({ profiles, providers = [], send, dispatch }: ProfilesPanelProps) {
	const [mode, setMode] = useState<Mode>({ kind: "list" });
	const list = profiles.list ?? [];
	const names = list.map((p) => p.name);
	const back = () => setMode({ kind: "list" });

	return (
		<section className="profiles" aria-label="Profiles">
			<header className="profiles-header">
				<h2>Profiles</h2>
				<button
					type="button"
					className="icon"
					aria-label="Close profiles"
					onClick={() => dispatch({ type: "profiles", open: false })}
				>
					×
				</button>
			</header>

			{mode.kind === "edit" ? (
				<ProfileEditor
					profile={mode.profile}
					roles={profiles.roles}
					models={profiles.models}
					providers={providers}
					taken={names}
					onCancel={back}
					onSave={(name, roles) => {
						send({ type: "profile_save", name, roles });
						back();
					}}
				/>
			) : mode.kind === "name" ? (
				<NameForm
					mode={mode}
					taken={names}
					onCancel={back}
					onSubmit={(name) => {
						const from = mode.from ?? "";
						if (mode.action === "save_current") send({ type: "profile_save_current", name });
						else if (mode.action === "rename") send({ type: "profile_rename", from, to: name });
						else send({ type: "profile_duplicate", from, to: name });
						back();
					}}
				/>
			) : (
				<>
					<p className="muted">
						A profile chooses the AI model each part of the assistant uses. Switch profiles any time.
					</p>
					{profiles.lastImport ? (
						<ImportResult
							result={profiles.lastImport}
							openAccounts={() => {
								send({ type: "auth_list" });
								dispatch({ type: "accounts", open: true });
							}}
						/>
					) : null}
					{profiles.list === undefined ? <p className="muted">Loading…</p> : null}
					{profiles.list?.length === 0 ? <p className="muted">No profiles yet.</p> : null}
					<ul className="profile-list">
						{list.map((profile) => {
							const inUse = profile.name === profiles.active;
							const deleting = mode.kind === "delete" && mode.name === profile.name;
							return (
								<li key={profile.name} className={inUse ? "in-use" : undefined}>
									<div className="profile-name">
										<b>{profile.name}</b>
										{inUse ? <span className="chip ok">In use</span> : null}
									</div>
									<p className="profile-summary">{summary(profile, profiles.roles, profiles.models)}</p>
									{deleting ? (
										<div className="profile-confirm" role="alertdialog" aria-label="Delete profile">
											<p>{`Delete “${profile.name}”? This cannot be undone.`}</p>
											<button
												type="button"
												className="primary danger"
												onClick={() => {
													send({ type: "profile_delete", name: profile.name });
													back();
												}}
											>
												Delete
											</button>
											<button type="button" onClick={back}>
												Keep it
											</button>
										</div>
									) : (
										<div className="profile-actions">
											{inUse ? null : (
												<button
													type="button"
													className="primary"
													onClick={() => send({ type: "profile_apply", name: profile.name })}
												>
													Use
												</button>
											)}
											<button type="button" onClick={() => setMode({ kind: "edit", profile })}>
												Edit
											</button>
											<button
												type="button"
												onClick={() => setMode({ kind: "name", action: "duplicate", from: profile.name })}
											>
												Duplicate
											</button>
											<button
												type="button"
												onClick={() => setMode({ kind: "name", action: "rename", from: profile.name })}
											>
												Rename
											</button>
											<button
												type="button"
												className="link"
												disabled={inUse}
												title={inUse ? "Switch to another profile before deleting this one." : undefined}
												onClick={() => setMode({ kind: "delete", name: profile.name })}
											>
												Delete
											</button>
										</div>
									)}
								</li>
							);
						})}
					</ul>
					<div className="profiles-footer">
						<button type="button" className="primary" onClick={() => setMode({ kind: "edit" })}>
							New profile
						</button>
						<button type="button" onClick={() => setMode({ kind: "name", action: "save_current" })}>
							Save my current setup
						</button>
						{profiles.importable ? (
							<button type="button" onClick={() => send({ type: "profile_import" })}>
								Import my Gentle Shell profiles
							</button>
						) : null}
					</div>
				</>
			)}
		</section>
	);
}

function modelLabel(model: string | undefined, models: ModelOption[]): string {
	if (!model) return "Default";
	return models.find((m) => `${m.provider}/${m.id}` === model)?.name ?? model;
}

/** One line per routed role the screen knows, for example "Main assistant: Fake Model · High". */
function summary(profile: Profile, roles: ProfileRole[], models: ModelOption[]): string {
	const lines = roles.flatMap((role) => {
		const route = profile.roles[role.id];
		if (!route) return [];
		const thinking = route.thinking ? ` · ${THINKING_LABELS[route.thinking]}` : "";
		return [`${role.label}: ${modelLabel(route.model, models)}${thinking}`];
	});
	return lines.length > 0 ? lines.join(", ") : "Uses the default model everywhere.";
}

function ProfileEditor({
	profile,
	roles,
	models,
	providers,
	taken,
	onSave,
	onCancel,
}: {
	profile?: Profile;
	roles: ProfileRole[];
	models: ModelOption[];
	providers: AuthProvider[];
	taken: string[];
	onSave: (name: string, roles: ProfileRoles) => void;
	onCancel: () => void;
}) {
	const [name, setName] = useState("");
	// Starts from every saved route, so roles this screen does not show are kept.
	const [routes, setRoutes] = useState<ProfileRoles>(() => structuredClone(profile?.roles ?? {}));
	const problem = profile ? undefined : nameProblem(name, taken);
	const valid = profile !== undefined || (name !== "" && problem === undefined);
	const groups = new Map<string, ModelOption[]>();
	for (const model of models) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
	const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

	const update = (role: string, change: Partial<RoleRoute>) =>
		setRoutes((current) => {
			const next: RoleRoute = { ...current[role], ...change };
			if (!next.model) delete next.model;
			if (!next.thinking) delete next.thinking;
			const { [role]: _removed, ...others } = current;
			return next.model || next.thinking ? { ...current, [role]: next } : others;
		});

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (valid) onSave(profile?.name ?? name, routes);
	};

	return (
		<form
			className="profile-editor"
			aria-label={profile ? `Edit ${profile.name}` : "New profile"}
			onSubmit={submit}
		>
			{profile ? (
				<h3>{profile.name}</h3>
			) : (
				<label className="profile-field">
					<span>Name</span>
					<input
						type="text"
						aria-label="Profile name"
						autoComplete="off"
						placeholder="for example deep-work"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					{problem ? <small className="profile-problem">{problem}</small> : null}
				</label>
			)}
			<div className="role-routes">
				{roles.map((role) => {
					const route = routes[role.id] ?? {};
					const known = !route.model || models.some((m) => `${m.provider}/${m.id}` === route.model);
					return (
						<div className="role-route" key={role.id}>
							<span className="role-label">{role.label}</span>
							<select
								aria-label={`${role.label} model`}
								value={route.model ?? ""}
								onChange={(event) => update(role.id, { model: event.target.value })}
							>
								<option value="">Default</option>
								{[...groups].map(([provider, options]) => (
									<optgroup key={provider} label={providerName(provider)}>
										{options.map((m) => (
											<option key={m.id} value={`${m.provider}/${m.id}`}>
												{m.name}
											</option>
										))}
									</optgroup>
								))}
								{known ? null : <option value={route.model}>{`${route.model} (not available)`}</option>}
							</select>
							<select
								aria-label={`${role.label} thinking`}
								value={route.thinking ?? ""}
								onChange={(event) =>
									update(role.id, {
										thinking: (event.target.value || undefined) as ThinkingLevel | undefined,
									})
								}
							>
								<option value="">Default</option>
								{THINKING_LEVELS.map((level) => (
									<option key={level} value={level}>
										{THINKING_LABELS[level]}
									</option>
								))}
							</select>
						</div>
					);
				})}
			</div>
			<div className="profile-form-actions">
				<button type="submit" className="primary" disabled={!valid}>
					Save
				</button>
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}

const NAME_FORMS = {
	rename: { label: "New name", submit: "Rename" },
	duplicate: { label: "Name for the copy", submit: "Duplicate" },
	save_current: { label: "Name for your current setup", submit: "Save" },
} as const;

function NameForm({
	mode,
	taken,
	onSubmit,
	onCancel,
}: {
	mode: Extract<Mode, { kind: "name" }>;
	taken: string[];
	onSubmit: (name: string) => void;
	onCancel: () => void;
}) {
	const initial = mode.action === "duplicate" ? `${mode.from}-copy` : (mode.from ?? "");
	const [name, setName] = useState(initial);
	const text = NAME_FORMS[mode.action];
	const problem = name === mode.from ? undefined : nameProblem(name, taken);
	const valid = name !== "" && name !== mode.from && problem === undefined;
	return (
		<form
			className="profile-editor"
			aria-label={text.label}
			onSubmit={(event) => {
				event.preventDefault();
				if (valid) onSubmit(name);
			}}
		>
			<label className="profile-field">
				<span>{text.label}</span>
				<input
					type="text"
					aria-label={text.label}
					autoComplete="off"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				{problem ? <small className="profile-problem">{problem}</small> : null}
			</label>
			<div className="profile-form-actions">
				<button type="submit" className="primary" disabled={!valid}>
					{text.submit}
				</button>
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}

function ImportResult({
	result,
	openAccounts,
}: {
	result: NonNullable<ProfilesState["lastImport"]>;
	openAccounts: () => void;
}) {
	const renamed = result.imported.filter((i) => i.from !== i.to);
	const count = result.imported.length;
	return (
		<div className="profiles-import" role="status">
			<p>{count === 0 ? "Nothing new to import." : `Imported ${count} profile${count === 1 ? "" : "s"}.`}</p>
			{renamed.length > 0 ? (
				<p>{`Renamed because the name was taken: ${renamed.map((r) => `${r.from} → ${r.to}`).join(", ")}.`}</p>
			) : null}
			{result.missingProviders.length > 0 ? (
				<p>
					{`Connect these accounts to use them: ${result.missingProviders.join(", ")}. `}
					<button type="button" className="link" onClick={openAccounts}>
						Open accounts
					</button>
				</p>
			) : null}
		</div>
	);
}

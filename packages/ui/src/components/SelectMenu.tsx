import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** One selectable row of the menu. */
export interface SelectOption {
	value: string;
	label: string;
}

/** Options under one heading, the way ProfilesPanel groups models by provider. */
export interface SelectGroup {
	label: string;
	options: SelectOption[];
}

export interface SelectMenuProps {
	/** The accessible name of the trigger and the list. */
	label: string;
	value: string;
	onChange: (value: string) => void;
	/** Options before any group (the ungrouped head of the list). */
	options?: SelectOption[];
	/** Options under headings, after `options`. */
	groups?: SelectGroup[];
	/** Compact trigger, for the small in-chat pickers. */
	compact?: boolean;
	/** Disables the trigger; the list never opens. */
	disabled?: boolean;
}

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const flat = (props: Pick<SelectMenuProps, "options" | "groups">): SelectOption[] => [
	...(props.options ?? []),
	...(props.groups ?? []).flatMap((group) => group.options),
];

/** The theme's select: a trigger button plus a portaled listbox, so the popup is drawn by our
 * theme instead of the browser's native one (the four native `<select>` the app had drew the
 * OS dropdown). Keyboard: arrows move, Enter picks, Escape and Tab close; clicking outside
 * closes; focus stays on the trigger the whole time, like a native combobox. */
export function SelectMenu({ label, value, onChange, options, groups, compact, disabled }: SelectMenuProps) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(() =>
		Math.max(
			0,
			flat({ options, groups }).findIndex((o) => o.value === value),
		),
	);
	/** Portal to body: panels with backdrop-filter establish fixed containing blocks and clip
	 * descendants. Viewport coordinates only work outside those panels. */
	const [anchor, setAnchor] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(
		null,
	);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLDivElement>(null);

	/** Anchor the actual list edge, not an estimated height (short upward lists are shorter). */
	const measure = useCallback(() => {
		const box = trigger.current?.getBoundingClientRect();
		if (!box) return;
		const height = Math.min(320, (window.innerHeight || 900) * 0.6);
		const below = window.innerHeight - box.bottom;
		const top = below < height + 12 && box.top > below ? null : box.bottom + 4;
		setAnchor(
			top === null
				? { bottom: window.innerHeight - box.top + 4, left: box.left, width: box.width }
				: { top, left: box.left, width: box.width },
		);
	}, []);
	const all = flat({ options, groups });
	const current = all.find((option) => option.value === value);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" || event.key === "Tab") setOpen(false);
		};
		const onClick = (event: MouseEvent) => {
			const target = event.target as Node;
			if (!root.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
		};
		const onMove = (event: Event) => {
			// Scrolling options does not move the trigger; scrolling its ancestors does.
			if (event.target instanceof Node && popup.current?.contains(event.target)) return;
			measure();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("mousedown", onClick);
		window.addEventListener("resize", onMove);
		window.addEventListener("scroll", onMove, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mousedown", onClick);
			window.removeEventListener("resize", onMove);
			window.removeEventListener("scroll", onMove, true);
		};
	}, [open, measure]);

	const pick = (option: SelectOption) => {
		setOpen(false);
		onChange(option.value);
	};

	const move = (delta: number) => {
		const next = (active + delta + all.length) % all.length;
		setActive(next);
	};

	const onTriggerKey = (event: React.KeyboardEvent) => {
		if (
			!open &&
			(event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ")
		) {
			event.preventDefault();
			measure();
			setOpen(true);
			return;
		}
		if (!open) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			move(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			move(-1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const option = all[active];
			if (option) pick(option);
		}
	};

	const optionRow = (option: SelectOption, index: number): ReactNode => (
		<div
			key={option.value}
			role="option"
			aria-selected={option.value === value}
			tabIndex={-1}
			className={`select-menu-option${index === active ? " active" : ""}`}
			onClick={() => pick(option)}
			onKeyDown={(event) => {
				if (event.key === "Enter") pick(option);
			}}
			onMouseMove={() => setActive(index)}
		>
			{option.label}
		</div>
	);

	return (
		<div className={`select-menu${compact ? " compact" : ""}`} ref={root}>
			<button
				type="button"
				className="select-menu-trigger"
				aria-label={label}
				aria-haspopup="listbox"
				aria-expanded={open}
				disabled={disabled}
				onKeyDown={onTriggerKey}
				ref={trigger}
				onClick={() => {
					if (!open) measure();
					setOpen(!open);
				}}
			>
				<span className="select-menu-value">{current?.label ?? value}</span>
				<svg
					className="select-menu-caret"
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
					focusable="false"
				>
					<title>icon</title>
					<path d="M6 9l6 6 6-6" />
				</svg>
			</button>
			{open && anchor
				? createPortal(
						<div
							ref={popup}
							// Keep enclosing popovers' document-level outside-pointer handlers from closing us.
							onPointerDown={(event) => event.stopPropagation()}
							className="select-menu-list"
							role="listbox"
							aria-label={label}
							style={
								anchor.bottom !== undefined
									? { bottom: anchor.bottom, left: anchor.left, minWidth: anchor.width }
									: { top: anchor.top, left: anchor.left, minWidth: anchor.width }
							}
						>
							{(options ?? []).map(optionRow)}
							{(groups ?? []).map((group) => (
								<div key={group.label} className="select-menu-group">
									<div className="select-menu-heading" id={`select-group-${slug(group.label)}`}>
										{group.label}
									</div>
									{group.options.map((option, index) => optionRow(option, index + (options?.length ?? 0)))}
								</div>
							))}
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}

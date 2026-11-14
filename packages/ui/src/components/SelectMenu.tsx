import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
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

const flat = (props: Pick<SelectMenuProps, "options" | "groups">): SelectOption[] => [
	...(props.options ?? []),
	...(props.groups ?? []).flatMap((group) => group.options),
];

/** The theme's select-only combobox plus a portaled listbox, so the popup is drawn by our
 * theme instead of the browser's native one (the four native `<select>` the app had drew the
 * OS dropdown). Keyboard: arrows move, Enter picks, Escape and Tab close; clicking outside
 * closes; focus stays on the trigger the whole time, like a native combobox. */
export function SelectMenu({ label, value, onChange, options, groups, compact, disabled }: SelectMenuProps) {
	const id = useId();
	const listId = `${id}-list`;
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
	const activeIndex = Math.min(active, Math.max(0, all.length - 1));
	const activeId = open && all.length > 0 ? `${id}-option-${activeIndex}` : undefined;

	useEffect(() => {
		const list = popup.current;
		const option = activeId ? document.getElementById(activeId) : null;
		if (!list || !option) return;
		const bounds = list.getBoundingClientRect();
		const row = option.getBoundingClientRect();
		// Scroll only the popup, never the page or the trigger's clipping ancestors.
		if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
		else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
	}, [activeId]);

	const show = () => {
		setActive(
			Math.max(
				0,
				all.findIndex((option) => option.value === value),
			),
		);
		measure();
		setOpen(true);
	};

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) {
				// Capture before enclosing popovers and the panel's window listener.
				event.preventDefault();
				event.stopPropagation();
				setOpen(false);
			} else if (event.key === "Tab") setOpen(false);
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
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("mousedown", onClick);
		window.addEventListener("resize", onMove);
		window.addEventListener("scroll", onMove, true);
		return () => {
			window.removeEventListener("keydown", onKey, true);
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
		if (all.length === 0) return;
		const next = (activeIndex + delta + all.length) % all.length;
		setActive(next);
	};

	const onTriggerKey = (event: React.KeyboardEvent) => {
		if (
			!open &&
			(event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ")
		) {
			event.preventDefault();
			event.stopPropagation();
			show();
			return;
		}
		if (!open) return;
		if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) event.stopPropagation();
		if (event.key === "ArrowDown") {
			event.preventDefault();
			move(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			move(-1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			const option = all[activeIndex];
			if (option) pick(option);
		}
	};

	const optionRow = (option: SelectOption, index: number): ReactNode => (
		<div
			key={option.value}
			role="option"
			id={`${id}-option-${index}`}
			onMouseDown={(event) => event.preventDefault()}
			aria-selected={option.value === value}
			tabIndex={-1}
			className={`select-menu-option${index === activeIndex ? " active" : ""}`}
			onClick={() => pick(option)}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					event.stopPropagation();
					pick(option);
				}
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
				role="combobox"
				className="select-menu-trigger"
				aria-label={label}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-activedescendant={activeId}
				disabled={disabled}
				onKeyDown={onTriggerKey}
				ref={trigger}
				onClick={() => {
					if (open) setOpen(false);
					else show();
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
							id={listId}
							aria-label={label}
							style={
								anchor.bottom !== undefined
									? { bottom: anchor.bottom, left: anchor.left, minWidth: anchor.width }
									: { top: anchor.top, left: anchor.left, minWidth: anchor.width }
							}
						>
							{(options ?? []).map(optionRow)}
							{(groups ?? []).map((group, groupIndex) => (
								// biome-ignore lint/a11y/useSemanticElements: listbox option groups are not form fieldsets
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: stateless groups may share labels; local index matches their heading IDs
									key={`${groupIndex}-${group.label}`}
									className="select-menu-group"
									role="group"
									aria-labelledby={`${id}-group-${groupIndex}`}
								>
									<div className="select-menu-heading" id={`${id}-group-${groupIndex}`}>
										{group.label}
									</div>
									{group.options.map((option) => optionRow(option, all.indexOf(option)))}
								</div>
							))}
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}

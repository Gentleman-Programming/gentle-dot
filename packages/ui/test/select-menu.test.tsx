import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectMenu } from "../src/components/SelectMenu.tsx";

function Harness({
	groups,
	initial = "",
	onChange,
}: {
	groups?: { label: string; options: { value: string; label: string }[] }[];
	initial?: string;
	onChange?: (value: string) => void;
}) {
	const [value, setValue] = useState(initial);
	return (
		<SelectMenu
			label="Voice language"
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange?.(next);
			}}
			options={[
				{ value: "", label: "Automatic (system language)" },
				{ value: "es", label: "Español" },
				{ value: "en", label: "English" },
			]}
			groups={groups}
		/>
	);
}

const open = () => userEvent.click(screen.getByRole("combobox", { name: "Voice language" }));
const listbox = () => screen.getByRole("listbox", { name: "Voice language" });

describe("SelectMenu", () => {
	it("A1 exposes the popup and pending option without changing confirmed selection", async () => {
		const onChange = vi.fn();
		const view = render(<Harness onChange={onChange} />);
		const trigger = screen.getByRole("combobox", { name: "Voice language" });
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(trigger).not.toHaveAttribute("aria-activedescendant");
		await userEvent.click(trigger);
		expect(trigger).toHaveFocus();
		expect(trigger).toHaveAttribute("aria-controls", listbox().id);
		expect(listbox().id).not.toBe("");
		const confirmed = screen.getByRole("option", { name: "Automatic (system language)" });
		expect(trigger).toHaveAttribute("aria-activedescendant", confirmed.id);
		await userEvent.keyboard("{ArrowDown}");
		const pending = screen.getByRole("option", { name: "Español" });
		expect(pending.id).not.toBe("");
		expect(trigger).toHaveAttribute("aria-activedescendant", pending.id);
		expect(pending).toHaveAttribute("aria-selected", "false");
		expect(confirmed).toHaveAttribute("aria-selected", "true");
		fireEvent.mouseMove(screen.getByRole("option", { name: "English" }));
		expect(trigger).toHaveAttribute(
			"aria-activedescendant",
			screen.getByRole("option", { name: "English" }).id,
		);
		await userEvent.keyboard("{Escape}");
		expect(trigger).not.toHaveAttribute("aria-activedescendant");
		expect(trigger).not.toHaveAttribute("aria-controls");
		expect(onChange).not.toHaveBeenCalled();
		view.rerender(<SelectMenu label="Voice language" value="" options={[]} onChange={onChange} />);
		await userEvent.click(trigger);
		expect(trigger).not.toHaveAttribute("aria-activedescendant");
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		await userEvent.keyboard("{Enter}");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("A2 exposes the closed combobox name separately from its visible text value", async () => {
		render(<Harness />);
		const trigger = screen.getByRole("combobox", { name: "Voice language" });
		expect(trigger).toHaveAccessibleName("Voice language");
		// A select-only ARIA combobox exposes its value from its text contents, not aria-valuenow.
		expect(trigger).toHaveTextContent(/^Automatic \(system language\)$/);
		expect(trigger).not.toHaveAttribute("aria-valuenow");
		await userEvent.click(trigger);
		await userEvent.click(screen.getByRole("option", { name: "English" }));
		expect(trigger).toHaveAccessibleName("Voice language");
		expect(trigger).toHaveTextContent(/^English$/);
		expect(trigger).toHaveAttribute("aria-expanded", "false");
	});

	it("A3 names provider groups with unique headings across similar labels and instances", () => {
		const groups = [
			{ label: "A B", options: [{ value: "a", label: "First" }] },
			{ label: "A-B", options: [{ value: "b", label: "Second" }] },
			{ label: "A B", options: [{ value: "c", label: "Third" }] },
		];
		render(
			<>
				<SelectMenu label="First picker" value="a" groups={groups} onChange={vi.fn()} />
				<SelectMenu label="Second picker" value="a" groups={groups} onChange={vi.fn()} />
			</>,
		);
		// Programmatic click keeps both instances open to inspect all live ID references.
		for (const trigger of screen.getAllByRole("combobox")) fireEvent.click(trigger);
		const headings = screen.getAllByRole("group");
		expect(headings).toHaveLength(6);
		for (const [index, group] of headings.entries()) {
			expect(group).toHaveAccessibleName(groups[index % groups.length]?.label);
			const heading = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
			expect(group).toContainElement(heading);
			expect(within(group).getAllByRole("option")).toHaveLength(1);
		}
		const ids = Array.from(document.querySelectorAll("[id]")).map((element) => element.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("A4 scrolls only the popup on open and keyboard or pointer exploration", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.getAttribute("role") === "listbox") return new DOMRect(0, 100, 200, 60);
			if (this.getAttribute("role") === "option")
				return new DOMRect(0, this.textContent === "Español" ? 80 : 170, 200, 20);
			return new DOMRect(0, 0, 200, 30);
		});
		render(<Harness />);
		await open();
		const list = listbox();
		expect(list.scrollTop).toBe(30);
		await userEvent.keyboard("{ArrowDown}");
		expect(list.scrollTop).toBe(10);
		fireEvent.mouseMove(screen.getByRole("option", { name: "English" }));
		expect(list.scrollTop).toBe(40);
		expect(document.documentElement.scrollTop).toBe(0);
		expect(document.body.scrollTop).toBe(0);
	});

	it("uses global indexes after multiple provider groups", async () => {
		const onChange = vi.fn();
		render(
			<SelectMenu
				label="Models"
				value=""
				onChange={onChange}
				options={[{ value: "", label: "Default" }]}
				groups={[
					{
						label: "A",
						options: [
							{ value: "a1", label: "A1" },
							{ value: "a2", label: "A2" },
						],
					},
					{ label: "B", options: [{ value: "b1", label: "B1" }] },
				]}
			/>,
		);
		await userEvent.click(screen.getByRole("combobox", { name: "Models" }));
		fireEvent.mouseMove(screen.getByRole("option", { name: "B1" }));
		await userEvent.keyboard("{Enter}");
		expect(onChange).toHaveBeenCalledExactlyOnceWith("b1");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("discards cancelled navigation when reopened", async () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		await open();
		await userEvent.keyboard("{ArrowDown}{Escape}");
		expect(onChange).not.toHaveBeenCalled();
		await open();
		await userEvent.keyboard("{Enter}");
		expect(onChange).toHaveBeenCalledExactlyOnceWith("");
		expect(screen.getByRole("combobox", { name: "Voice language" })).toHaveTextContent("Automatic");
	});

	it("reopens at the authoritative value after options and value change", async () => {
		const onChange = vi.fn();
		const view = render(
			<SelectMenu
				label="Choice"
				value="b"
				onChange={onChange}
				options={[
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				]}
			/>,
		);
		await userEvent.click(screen.getByRole("combobox", { name: "Choice" }));
		await userEvent.keyboard("{Escape}");
		view.rerender(
			<SelectMenu label="Choice" value="c" onChange={onChange} options={[{ value: "c", label: "C" }]} />,
		);
		await userEvent.click(screen.getByRole("combobox", { name: "Choice" }));
		await userEvent.keyboard("{Enter}");
		expect(onChange).toHaveBeenCalledExactlyOnceWith("c");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	function geometry(top = 600) {
		vi.stubGlobal("innerHeight", 800);
		let rect = new DOMRect(80, top, 180, 32);
		vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockImplementation(() => rect);
		return (nextTop: number, left = 80) => {
			rect = new DOMRect(left, nextTop, 180, 32);
		};
	}

	it("anchors a short upward popup by its bottom, outside clipping and fixed containing blocks", async () => {
		geometry();
		const { container } = render(
			<div style={{ transform: "translateY(40px)", backdropFilter: "blur(12px)", overflow: "hidden" }}>
				<Harness />
			</div>,
		);
		await open();
		const list = listbox();
		// No guessed 320px height: even a three-row popup ends exactly 4px above the trigger.
		expect(list.style.bottom).toBe("204px");
		expect(list.style.top).toBe("");
		expect(list.style.left).toBe("80px");
		expect(list.style.minWidth).toBe("180px");
		expect(list.parentElement).toBe(document.body);
		expect(container).not.toContainElement(list);
		expect(within(list).getAllByRole("option")).toHaveLength(3);
	});

	it("keeps an upward popup attached after ancestor scrolling and viewport resize", async () => {
		const relocate = geometry();
		render(
			<div data-testid="scroller" style={{ overflow: "auto" }}>
				<Harness />
			</div>,
		);
		await open();
		expect(listbox().style.bottom).toBe("204px");
		relocate(500, 100);
		fireEvent.scroll(screen.getByTestId("scroller"));
		expect(listbox().style.bottom).toBe("304px");
		expect(listbox().style.left).toBe("100px");
		vi.stubGlobal("innerHeight", 700);
		fireEvent.resize(window);
		expect(listbox().style.bottom).toBe("204px");
		expect(listbox().style.top).toBe("");
	});

	it("opens below when there is room and switches direction after moving", async () => {
		const relocate = geometry(100);
		render(<Harness />);
		await open();
		expect(listbox().style.top).toBe("136px");
		expect(listbox().style.bottom).toBe("");
		relocate(650);
		fireEvent.scroll(window);
		expect(listbox().style.bottom).toBe("154px");
		expect(listbox().style.top).toBe("");
	});

	it("does not dismiss a portaled option on mousedown and still selects it", async () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		await open();
		const option = screen.getByRole("option", { name: "English" });
		fireEvent.mouseDown(option);
		expect(listbox()).toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
		await userEvent.click(option);
		expect(onChange).toHaveBeenCalledExactlyOnceWith("en");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("keeps a containing popover open while choosing a portaled option", async () => {
		const onChange = vi.fn();
		function Popover() {
			const root = useRef<HTMLDivElement>(null);
			const [visible, setVisible] = useState(true);
			useEffect(() => {
				const dismiss = (event: PointerEvent) => {
					if (!root.current?.contains(event.target as Node)) setVisible(false);
				};
				document.addEventListener("pointerdown", dismiss);
				return () => document.removeEventListener("pointerdown", dismiss);
			}, []);
			return <div ref={root}>{visible ? <Harness onChange={onChange} /> : null}</div>;
		}
		render(<Popover />);
		await open();
		await userEvent.click(screen.getByRole("option", { name: "English" }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith("en");
		expect(screen.getByRole("combobox", { name: "Voice language" })).toHaveTextContent("English");
	});

	it("keeps disabled triggers closed", async () => {
		const onChange = vi.fn();
		render(
			<SelectMenu
				label="Disabled"
				value="en"
				options={[{ value: "en", label: "English" }]}
				onChange={onChange}
				disabled
			/>,
		);
		const trigger = screen.getByRole("combobox", { name: "Disabled" });
		await userEvent.click(trigger);
		expect(trigger).toBeDisabled();
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("selects a grouped option without treating it as an outside click", async () => {
		const onChange = vi.fn();
		render(
			<Harness
				onChange={onChange}
				groups={[{ label: "Provider", options: [{ value: "model", label: "Model" }] }]}
			/>,
		);
		await open();
		await userEvent.click(screen.getByRole("option", { name: "Model" }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith("model");
		expect(screen.getByRole("combobox", { name: "Voice language" })).toHaveTextContent("Model");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});
	it("renders a select-only combobox styled by the theme, not a native select", () => {
		const { container } = render(<Harness />);
		const trigger = screen.getByRole("combobox", { name: "Voice language" });
		expect(trigger).toHaveTextContent("Automatic (system language)");
		expect(container.querySelector("select")).toBeNull();
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("opens the list on click, shows every option, and closes on Escape, outside click and pick", async () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		await open();
		expect(listbox()).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Español" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "English" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Automatic (system language)" })).toHaveAttribute(
			"aria-selected",
			"true",
		);

		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

		await open();
		await userEvent.click(document.body);
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

		await open();
		await userEvent.click(screen.getByRole("option", { name: "Español" }));
		expect(onChange).toHaveBeenCalledWith("es");
		expect(screen.getByRole("combobox", { name: "Voice language" })).toHaveTextContent("Español");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("navigates with the keyboard: arrows move the active option, Enter picks it", async () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		await open();
		await userEvent.keyboard("{ArrowDown}");
		expect(screen.getByRole("option", { name: "Español" }).className).toContain("active");
		await userEvent.keyboard("{Enter}");
		expect(onChange).toHaveBeenCalledWith("es");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("renders grouped options under their provider heading", async () => {
		render(
			<Harness
				groups={[
					{
						label: "OpenAI",
						options: [{ value: "openai/gpt", label: "GPT" }],
					},
				]}
			/>,
		);
		await open();
		const list = listbox();
		const heading = within(list).getByText("OpenAI");
		expect(heading.className).toBe("select-menu-heading");
		expect(within(list).getByRole("option", { name: "GPT" })).toBeInTheDocument();
	});

	it("keeps focus reachable: the list opens focused, closes with Tab, and returns focus to the trigger", async () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		const trigger = screen.getByRole("combobox", { name: "Voice language" });
		await userEvent.click(trigger);
		expect(document.activeElement).toBe(trigger);
		await userEvent.keyboard("{ArrowDown}");
		await userEvent.tab();
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
		expect(trigger).toHaveTextContent("Automatic (system language)");
		expect(onChange).not.toHaveBeenCalled();
	});
});

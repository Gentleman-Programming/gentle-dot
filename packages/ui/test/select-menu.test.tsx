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

const open = () => userEvent.click(screen.getByRole("button", { name: "Voice language" }));
const listbox = () => screen.getByRole("listbox", { name: "Voice language" });

describe("SelectMenu", () => {
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
		expect(screen.getByRole("button", { name: "Voice language" })).toHaveTextContent("English");
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
		const trigger = screen.getByRole("button", { name: "Disabled" });
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
		expect(screen.getByRole("button", { name: "Voice language" })).toHaveTextContent("Model");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});
	it("renders a trigger button styled by the theme, not a native select", () => {
		const { container } = render(<Harness />);
		const trigger = screen.getByRole("button", { name: "Voice language" });
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
		expect(screen.getByRole("button", { name: "Voice language" })).toHaveTextContent("Español");
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
		render(<Harness />);
		const trigger = screen.getByRole("button", { name: "Voice language" });
		await userEvent.click(trigger);
		expect(document.activeElement).toBe(trigger);
		await userEvent.tab();
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});
});

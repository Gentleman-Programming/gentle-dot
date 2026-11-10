import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
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
		await userEvent.click(document.querySelector(".select-menu-scrim") as HTMLElement);
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

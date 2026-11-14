import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** The header actions live behind the hamburger now (design/ui-header-menu/02): open it. */
export async function openPanelMenu(): Promise<void> {
	await userEvent.click(screen.getByRole("button", { name: "Panel menu" }));
}

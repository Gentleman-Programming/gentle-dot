import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("ui test environment", () => {
	it("renders React into jsdom", () => {
		render(<p>Gentle Dot</p>);
		expect(screen.getByText("Gentle Dot")).toBeInTheDocument();
	});
});

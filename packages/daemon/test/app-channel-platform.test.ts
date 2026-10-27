import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childInherits, inheritedAppSocket, openInheritedChannel } from "../src/app-channel.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", () => ({
	closeSync: vi.fn(),
	fstatSync: vi.fn(() => {
		throw new Error("Unix descriptor inspection must not run on Windows");
	}),
}));
vi.mock("node:net", () => ({ Socket: vi.fn() }));

const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
if (!descriptor) throw new Error("process.platform has no own property descriptor");
const platformDescriptor: PropertyDescriptor = descriptor;
afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.clearAllMocks();
});

// Dispatch tests only: changing this property does not emulate native Windows handles.
describe("app channel acquisition on Windows", () => {
	it("refuses socket acquisition before any Unix descriptor inspection or wrapping", () => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		const probe = vi.fn();
		expect(inheritedAppSocket({ probe })).toBeUndefined();
		expect(fstatSync).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(Socket).not.toHaveBeenCalled();
	});

	it("leaves the public channel opener disconnected without a Windows transport", () => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		expect(openInheritedChannel()).toBeUndefined();
		expect(fstatSync).not.toHaveBeenCalled();
		expect(Socket).not.toHaveBeenCalled();
	});

	it("treats the Unix inheritance probe as unproven without spawning on Windows", () => {
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		expect(childInherits(3, "0:0")).toBe(true);
		expect(spawnSync).not.toHaveBeenCalled();
	});
});

// The harness itself has to work before 24 files depend on it: boot, listen, stop.
import net from "node:net";
import { describe, expect, it } from "vitest";
import { bootDaemon, freePort } from "./harness.ts";

const listening = (port: number) =>
	new Promise<boolean>((resolve) => {
		const socket = net.createConnection({ port, host: "127.0.0.1" });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});

describe("the daemon test harness", () => {
	it("boots a daemon with the fake engine on a real port and stops it cleanly", async () => {
		const port = await freePort();
		const booted = await bootDaemon({ port });

		expect(await listening(port)).toBe(true);

		await booted.stop();
		expect(await listening(port)).toBe(false);
	}, 180_000);
});

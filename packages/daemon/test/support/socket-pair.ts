import { connect, createServer, type Socket } from "node:net";

/** Owned loopback pair: no Unix path-length limit and no external listener. */
export async function socketPair(): Promise<{ app: Socket; daemon: Socket }> {
	const server = createServer();
	let app: Socket | undefined;
	let daemon: Socket | undefined;
	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("socket pair setup timed out")), 2_000);
			const fail = (error: Error) => {
				clearTimeout(timer);
				reject(error);
			};
			let connected = false;
			const ready = () => {
				if (!app || !daemon || !connected) return;
				clearTimeout(timer);
				app.removeListener("error", fail);
				daemon.removeListener("error", fail);
				resolve({ app, daemon });
			};
			server.once("error", fail);
			server.once("connection", (socket) => {
				app = socket;
				app.once("error", fail);
				ready();
			});
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address === "string") {
					fail(new Error("socket pair has no TCP address"));
					return;
				}
				daemon = connect(address.port, "127.0.0.1");
				daemon.once("error", fail);
				daemon.once("connect", () => {
					connected = true;
					ready();
				});
			});
		});
	} catch (error) {
		app?.destroy();
		daemon?.destroy();
		throw error;
	} finally {
		server.close();
	}
}

import { createRequire } from "node:module";

// Set after bootstrap: Node may consume/delete NODE_CHANNEL_FD during startup.
if (process.argv[3] === "ipc") process.env.NODE_CHANNEL_FD = "3";
else delete process.env.NODE_CHANNEL_FD;
const addon = createRequire(import.meta.url)(process.argv[2]);
const failures = [];
for (let attempt = 0; attempt < (process.argv[3] === "twice" ? 2 : 1); attempt++) {
	try {
		addon.adoptAppChannelFd3(true);
		throw new Error("Unexpected adoption success");
	} catch (error) {
		failures.push({ message: error.message, code: error.code, evidence: error.evidence });
	}
}
process.stdout.write(JSON.stringify(failures));

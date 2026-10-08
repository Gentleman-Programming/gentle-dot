#!/usr/bin/env node
// A stand-in for the engine's `mcp login <server>` and `mcp logout <server>` commands.
// login prints the authorization URL like the engine does, then waits on a loopback
// callback (`/callback?code=…&state=fake-state`); on that request it stores a sign-in
// in `<PI_CODING_AGENT_DIR>/mcp-auth.json` under `mcp__<server>|<url>` (`-` as `_`, like the engine) and exits 0.
// logout removes that key. Environment:
//   FAKE_MCP_CLI_LOG   append {argv, env} as JSONL for every run
//   FAKE_MCP_CLI_MODE  "fail": exit 1 after printing the URL; "auto": finish without a callback
//   FAKE_MCP_CLI_URL   the server URL stored with the sign-in (default Notion's)
//   FAKE_MCP_CLI_REDIRECT  the callback answers with a redirect to this address
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [command, name] = process.argv.slice(2).filter((arg) => arg !== "mcp");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? ".";
const authFile = join(agentDir, "mcp-auth.json");
const key = `mcp__${name?.replace(/-/g, "_")}|${process.env.FAKE_MCP_CLI_URL ?? "https://mcp.notion.com/mcp"}`;

if (process.env.FAKE_MCP_CLI_LOG) {
	appendFileSync(
		process.env.FAKE_MCP_CLI_LOG,
		`${JSON.stringify({
			argv: process.argv.slice(2),
			pid: process.pid,
			env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HOME: process.env.HOME },
		})}\n`,
	);
}

function readAuth(): Record<string, unknown> {
	return existsSync(authFile) ? (JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>) : {};
}

if (command === "logout") {
	const states = readAuth();
	const had = key in states;
	delete states[key];
	writeFileSync(authFile, JSON.stringify(states));
	console.log(
		had ? `Signed out of MCP server "${name}".` : `No stored credentials for MCP server "${name}".`,
	);
	process.exit(0);
}

if (command !== "login") {
	console.error(`Unknown mcp command "${command}".`);
	process.exit(1);
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (url.pathname !== "/callback" || url.searchParams.get("state") !== "fake-state") {
		res.writeHead(400).end("bad callback");
		return;
	}
	const elsewhere = process.env.FAKE_MCP_CLI_REDIRECT;
	if (elsewhere) res.writeHead(302, { Location: elsewhere }).end();
	else res.writeHead(200).end("You can close this page.");
	finish();
});

function finish(): void {
	const states = readAuth();
	states[key] = { tokens: { access_token: "fake-access-token-value", token_type: "Bearer" } };
	writeFileSync(authFile, JSON.stringify(states));
	console.log(`Signed in to MCP server "${name}" (3 tools).`);
	server.close();
	process.exit(0);
}

server.listen(0, "127.0.0.1", () => {
	const { port } = server.address() as { port: number };
	const redirect = encodeURIComponent(`http://127.0.0.1:${port}/callback`);
	console.log(
		`Sign in to MCP server "${name}" in your browser:\nhttps://auth.example.com/authorize?response_type=code&client_id=fake&state=fake-state&redirect_uri=${redirect}`,
	);
	if (process.env.FAKE_MCP_CLI_MODE === "fail") {
		setTimeout(() => {
			console.error(`Sign-in to MCP server "${name}" failed: invalid_client for https://auth.example.com/x`);
			process.exit(1);
		}, 150);
	}
	if (process.env.FAKE_MCP_CLI_MODE === "auto") setTimeout(finish, 150);
});

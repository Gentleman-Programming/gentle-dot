#!/usr/bin/env node
// A minimal MCP server over stdio (newline-delimited JSON-RPC) with two tools: `list_messages`,
// which declares itself read-only, and `send_message`, which does not. Each call is appended to
// FAKE_MCP_SERVER_CALLS as JSONL, so a test can tell which calls really ran.
import { appendFileSync } from "node:fs";

type Request = { jsonrpc: "2.0"; id?: number | string; method: string; params?: Record<string, unknown> };

const TOOLS = [
	{
		name: "list_messages",
		description: "List recent messages.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	},
	{
		name: "send_message",
		description: "Send a message.",
		inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } } },
		annotations: { readOnlyHint: false },
	},
];

function reply(id: Request["id"], result: unknown): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
	buffer += chunk.toString("utf8");
	for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line) as Request);
	}
});

function handle(request: Request): void {
	if (request.id === undefined) return;
	switch (request.method) {
		case "initialize":
			reply(request.id, {
				protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "fake", version: "1.0.0" },
			});
			return;
		case "tools/list":
			reply(request.id, { tools: TOOLS });
			return;
		case "tools/call":
			if (process.env.FAKE_MCP_SERVER_CALLS)
				appendFileSync(process.env.FAKE_MCP_SERVER_CALLS, `${JSON.stringify(request.params)}\n`);
			reply(request.id, { content: [{ type: "text", text: `ran ${String(request.params?.name)}` }] });
			return;
		default:
			reply(request.id, {});
	}
}

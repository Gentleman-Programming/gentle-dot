import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPowerShellOperations } from "./powershell-operations.ts";

type Loader = () => Promise<
	Pick<typeof import("@earendil-works/pi-coding-agent"), "createPowerShellToolDefinition">
>;

/** Called only by the guard bootstrap, after its tool_call hook is installed. */
export async function registerWindowsPowerShell(
	pi: ExtensionAPI,
	options: { platform?: NodeJS.Platform; subagent?: boolean } = {},
	load: Loader = () => import("@earendil-works/pi-coding-agent"),
): Promise<void> {
	if ((options.platform ?? process.platform) !== "win32" || options.subagent) return;
	// Shadow the built-in backend even if loading/definition construction fails. Never fall back to it.
	pi.registerTool({
		name: "powershell",
		label: "PowerShell unavailable",
		description: "Native Windows PowerShell could not be initialized.",
		exposure: "hidden",
		defaultActive: false,
		parameters: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
		} as never,
		async execute() {
			throw new Error("Native Windows PowerShell is unavailable.");
		},
	});
	try {
		const { createPowerShellToolDefinition } = await load();
		const definition = createPowerShellToolDefinition(process.cwd(), {
			operations: createPowerShellOperations(),
			exposeSessionEnvironment: false,
		});
		pi.registerTool({ ...definition, exposure: "direct", defaultActive: false } as ToolDefinition);
	} catch {
		// Keep startup and the previous Bash loadout working; the hidden replacement fails closed.
		return;
	}
	pi.on("session_start", () => {
		const previous = pi.getActiveTools();
		// Explicit settings/loadouts are not permission to expand the tool set. The SDK's getAllTools
		// is allowlist/exclusion-filtered; direct exposure also keeps inactive tools out of codemode.
		if (
			pi.getSettings().defaultTools !== undefined ||
			!previous.includes("bash") ||
			previous.includes("powershell")
		)
			return;
		if (
			!pi
				.getAllTools()
				.some(
					(tool: { name: string; exposure?: string }) =>
						tool.name === "powershell" && tool.exposure === "direct",
				)
		)
			return;
		try {
			pi.setActiveTools(previous.map((name: string) => (name === "bash" ? "powershell" : name)));
			if (!pi.getActiveTools().includes("powershell")) pi.setActiveTools(previous);
		} catch {
			pi.setActiveTools(previous);
		}
	});
}

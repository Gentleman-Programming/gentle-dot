// Starts the bundled engine for the subagent probe the way gentle-shell starts it in the assistant's
// home (`PI_CODING_AGENT_DIR` and `GENTLE_PI_AGENT_HOME` at `--home`, gentle-pi loaded with `-e`),
// without gentle-shell's first-run setup, which needs the network. Only gentle-pi's subagents
// extension is loaded. Usage (the daemon appends `--home`, `--mode rpc`, and the rest):
//   node engine-launcher.ts <pi cli.js> <gentle-agents.ts> --home <dir> ...
import { spawn } from "node:child_process";

const [cli, agents, ...rest] = process.argv.slice(2);
const at = rest.indexOf("--home");
const home = at >= 0 ? rest[at + 1] : undefined;
if (!cli || !agents || !home) {
	process.stderr.write("usage: engine-launcher.ts <pi cli.js> <gentle-agents.ts> --home <dir> ...\n");
	process.exit(2);
}
rest.splice(at, 2);
const child = spawn(process.execPath, [cli, "-e", agents, ...rest], {
	stdio: "inherit",
	env: { ...process.env, PI_CODING_AGENT_DIR: home, GENTLE_PI_AGENT_HOME: home },
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

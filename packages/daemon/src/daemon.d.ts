import { DotBridge } from "./bridge.ts";
import { AgentSupervisor } from "./supervisor.ts";
export interface DaemonOptions {
    port: number;
    host: string;
    dataDir: string;
    workspace: string;
    /** Directory with the built web UI (`index.html`). */
    uiDir: string;
    agentCommand: string;
    agentArgs?: string[];
    agentExtraArgs?: string[];
    agentEnv?: NodeJS.ProcessEnv;
    /** Origins allowed to open the WebSocket, besides the daemon's own and the desktop app's. */
    allowedOrigins?: string[];
    backoffMs?: number[];
    log?: (line: string) => void;
}
export interface DotDaemon {
    port: number;
    token: string;
    url: string;
    bridge: DotBridge;
    supervisor: AgentSupervisor;
    close(): Promise<void>;
}
/** Reads the access token from `<dataDir>/token`, creating a random one (mode 0600) when absent. */
export declare function ensureToken(dataDir: string): string;
export declare function startDaemon(options: DaemonOptions): Promise<DotDaemon>;

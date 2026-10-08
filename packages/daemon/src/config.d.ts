export interface DotConfig {
    port: number;
    host: string;
    dataDir: string;
    workspace: string;
    uiDir: string;
    agentCommand: string;
    agentArgs: string[];
    allowedOrigins: string[];
}
/** Resolves configuration from environment variables, then `~/.gentle-dot/config.json`, then defaults. */
export declare function loadConfig(env?: NodeJS.ProcessEnv): DotConfig;

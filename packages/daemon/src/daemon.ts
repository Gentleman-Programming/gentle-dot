/**
 * Daemon - Main orchestrator for the single daemon on port 4317
 * Coordinates: Config Loader, WebSocket Server, Connector Registry, Gentle Shell Spawner, MCP Proxy, App Channel
 */

import { loadAndValidateConfig, watchConfig, type AppConfig } from './config-loader.ts';
import { WsServer } from './ws-server.ts';
import { ConnectorRegistry, connectorRegistry, type ConnectorInfo, type ConnectorType } from './connector-registry.ts';
import { GentleShellSpawner, type ShellConfig } from './gentle-shell-spawner.ts';
import { isolatedAgentEnv } from './isolation.ts';
import { directAccess } from './engine-access.ts';
import { isBlockedInput, presentText } from './white-label.ts';
import { McpProxy, type ApprovalPreview } from './mcp-proxy.ts';

type McpMode = 'read_only' | 'read_write';
import { AppChannel, type AppMessage } from './app-channel.ts';
import { childGuardFile, installChildGuardFile, watchChildGuard } from './child-guard.ts';
import { Transcript } from './transcript.ts';
import { AuthManager, createModelAuthRuntime, type AuthRuntime } from './auth.ts';
import { ProfileError, ProfileStore, defaultImportPath, splitModel, toModelOptions } from './profiles.ts';
import { UploadStore, composePrompt } from './uploads.ts';
import { ConnectorManager, ConnectorStore } from './connectors.ts';
import { AppSecretSource } from './secret-source.ts';
import type { AttachmentRef } from '@gentle-dot/protocol';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'path';
import type { Duplex } from 'node:stream';

export interface DaemonOptions {
  configPath?: string;
  port?: number;
  host?: string;
  dataDir?: string;
  workspace?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  noAutoSetup?: boolean;
  /**
   * Engine argv override (`[bin, ...args]`), for tests and for pointing the daemon at a
   * specific engine build. Defaults to `gentle-shell` resolved from PATH, with the usual
   * rpc arguments appended.
   */
  engineCommand?: string[];
  /**
   * The app's side of its pipe (fd 3). A daemon launched by the app lives as long as that pipe:
   * when it closes, the daemon stops. Without it the daemon runs on its own.
   */
  appChannel?: Duplex;
  /** Sign-in runtime for the accounts screen; tests inject one, production builds it from the engine home. */
  authRuntime?: () => Promise<AuthRuntime>;
  /** Another setup's profiles.json, only ever read, for the one-time import. */
  profilesImportPath?: string;
  /** OAuth runner for the connectors' own sign-in; tests inject one. */
  connectorOAuth?: NonNullable<ConstructorParameters<typeof ConnectorManager>[0]['oauth']>;
  /** The home folder "Import my MCP servers" scans; default the user's. */
  importHome?: string;
  /** Upload limits for the desktop app's files; the store's defaults apply when absent. */
  uploadLimits?: { fileBytes: number; messageBytes: number; files: number };
}

/** Las peticiones de UI que son preguntas para el usuario; `setStatus`/`notify` no lo son. */
const ASK_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export class Daemon {
  private config: AppConfig;
  private wsServer: WsServer;
  private registry: ConnectorRegistry;
  private shellSpawner: GentleShellSpawner;
  private mcpProxy!: McpProxy;
  private appChannel: AppChannel;
  private configWatcher: ReturnType<typeof watchConfig> | null = null;
  private shutdown = false;
  private options: DaemonOptions;

  constructor(options: DaemonOptions = {}) {
    this.options = options;

    // Load initial config
    const configPath = options.configPath || path.join(process.cwd(), 'packages', 'daemon', 'connectors.yaml');
    this.config = loadAndValidateConfig(configPath);

    // Override config with CLI options
    if (options.port) this.config.daemon.port = options.port;
    if (options.host) this.config.daemon.host = options.host;
    if (options.dataDir) this.config.daemon.data_dir = options.dataDir;
    if (options.workspace) this.config.daemon.workspace = options.workspace;
    if (options.logLevel) this.config.daemon.log_level = options.logLevel;

    // Initialize components
    this.registry = connectorRegistry;
    this.wsServer = new WsServer(this.registry, this.config);
    // One spawner per daemon: a shared singleton makes a second daemon in the same process
    // fail with "Gentle Shell already running", which is how tests boot several.
    this.shellSpawner = new GentleShellSpawner();
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    // A pipe from the app replaces the socket server: one class, two transports.
    this.appChannel = this.options.appChannel
      ? new AppChannel(this.options.appChannel)
      : new AppChannel({ daemonPort: this.config.daemon.port });

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers between components
   */
  private setupEventHandlers(): void {
    // Registry events
    this.registry.on('onConnectorRegistered', (info: ConnectorInfo) => {
      console.log(`[Daemon] Connector registered: ${info.connectorId} (${info.type})`);
      this.appChannel.broadcast('connector_connected', {
        connectorId: info.connectorId,
        type: info.type,
        status: info.status,
      });
    });

    this.registry.on('onConnectorUnregistered', (connectorId: string) => {
      console.log(`[Daemon] Connector unregistered: ${connectorId}`);
      this.appChannel.broadcast('connector_disconnected', { connectorId });
    });

    this.registry.on('onConnectorStatusChange', (connectorId: string, status: string) => {
      console.log(`[Daemon] Connector status change: ${connectorId} -> ${status}`);
      this.appChannel.broadcast('connector_status', { connectorId, status });
    });

    // WebSocket server events
    this.wsServer.modelName = () => this.currentModel?.name;
    this.uploads = new UploadStore({
      workspace: this.config.daemon.workspace,
      ...(this.options.uploadLimits ? { limits: this.options.uploadLimits } : {}),
    });
    this.wsServer.uploads = this.uploads;

    this.wsServer.on('onMessage', (connectorId: string, message: any) => {
      this.handleBridgeMessage(connectorId, message);
    });

    // Windows speak the client protocol: their frames are flat, so they get their own switch
    // instead of the bridge envelope one.
    this.wsServer.on('onAppMessage', (clientId: string, message: any) => {
      void this.handleAppFrame(clientId, message);
    });
    this.wsServer.on('onConnection', (ws, connectorId) => {
      console.log(`[Daemon] Bridge connected: ${connectorId}`);
    });

    this.wsServer.on('onDisconnection', (connectorId, code, reason) => {
      console.log(`[Daemon] Bridge disconnected: ${connectorId} (${code}: ${reason})`);
      // Si el conector origen del run activo se cae, cerramos el run:
      // la respuesta no tendría destino. El steer de otros conectores sigue vivo.
      const run = this.activeRun;
      if (run && run.connectorId === connectorId) {
        console.log(`[Daemon] run activo ${run.messageId} abandonado (conector ${connectorId} desconectado)`);
        this.activeRun = null;
        this.shellSpawner.rpc('abort', {}, 60_000).catch(() => {});
      }
    });

    // The daemon lives as long as the app that launched it (S35.2, #22): when its pipe goes,
    // there is nobody left to talk to.
    this.appChannel.on('disconnect', () => {
      if (this.stopped || this.stopping) return;
      console.log("the desktop app's channel closed; stopping the assistant");
      void this.stop();
    });

    // The panel's channel is the other way a window's app command reaches the daemon.
    this.appChannel.registerHandler('command', async (params) => {
      const request = params as { clientId?: unknown; message?: { type?: string } };
      const clientId = typeof request?.clientId === 'string' ? request.clientId : '';
      if (clientId !== '' && request.message) await this.handleAppFrame(clientId, request.message);
      return {};
    });

    // A window that disappears takes its sign-in with it.
    this.wsServer.on('onAppDisconnect', (clientId: string) => {
      const owner = this.authOwners.get(clientId);
      if (!owner) return;
      this.authManagersCancel(owner);
      this.connectorManager?.cancelOwnedBy(owner);
      this.authOwners.delete(clientId);
    });

    // App Channel events
    this.appChannel.on('onMessage', (clientId: string, message: AppMessage) => {
      this.handleAppMessage(clientId, message);
    });
  }

  /** The approval guard module the engine loads with `-e`, next to this daemon's sources. */
  private approvalGuardPath(): string {
    return fileURLToPath(new URL('./extensions/approval-guard.ts', import.meta.url));
  }

  /** Cancels what a window owned; the manager aborts its flow if it was that window's. */
  private authManagersCancel(owner: object): void {
    this.authManager?.cancelOwnedBy(owner);
  }

  /** The stable owner object for a window, so its flows cannot be answered from another one. */
  private authOwner(clientId: string): object {
    const existing = this.authOwners.get(clientId);
    if (existing) return existing;
    const owner = {};
    this.authOwners.set(clientId, owner);
    return owner;
  }

  /**
   * Tells the window why a prompt failed. "Connect an account" only when nothing is connected:
   * with an account in place the same engine message means something else went wrong.
   */
  private async reportPromptFailure(connectorId: string, message: string): Promise<void> {
    let configured = false;
    try {
      configured = ((await this.authManager?.providers()) ?? []).some((provider) => provider.configured);
    } catch {
      // Treat an unreadable list as "nothing connected": the advice is still the useful one.
    }
    const noAccount = !configured && /no (api key|model|account)|not signed in/i.test(message);
    this.wsServer.deliver(
      connectorId,
      'error',
      noAccount
        ? { code: 'no_account', message: 'Connect an AI account first: open Accounts or type /login.' }
        : { code: 'command_failed', message: 'That did not work. Please try again.' },
    );
  }

  /**
   * Runs one connector action for the window that asked. The sign-in steps travel to that window
   * only (the others just see the screen refreshed), and a change of connectors restarts the
   * engine so its policy matches — never in the middle of an answer.
   */
  private async connectorAction(
    clientId: string,
    action: 'connect' | 'signIn' | 'disconnect',
    connectorId: string,
  ): Promise<void> {
    const manager = this.connectorManager;
    if (!manager || connectorId === '') return;
    const owner = this.authOwner(clientId);
    const emit = (event: { type: string } & Record<string, unknown>) => {
      const { type, ...payload } = event;
      this.wsServer.deliver(clientId, type, payload);
      // A sign-in finishes long after it starts: the files and the policy change only then, so
      // that is when the screen is refreshed and the engine restarts with the new policy.
      if (type === 'auth_done') {
        // The store writes the new sign-in a moment after the flow reports done: settle first, so
        // the screen every window receives already says "connected" and the restarted engine reads
        // the policy that includes the connector.
        void (async () => {
          await this.connectorStore?.settled().catch(() => undefined);
          await this.connectorsScreen();
          await this.restartEngine();
        })();
      }
    };
    const refusal =
      action === 'disconnect'
        ? manager.disconnect(connectorId)
        : action === 'signIn'
          ? manager.signIn(owner, connectorId, emit as never)
          : manager.connect(owner, connectorId, emit as never);
    if (refusal) {
      this.wsServer.deliver(clientId, 'error', { code: refusal.code, message: refusal.message });
      return;
    }

    // The screen is stale either way; a change that is already done (a disconnect) restarts the
    // engine here, and a sign-in restarts when its flow closes.
    await this.connectorsScreen();
    if (action === 'disconnect') void this.restartEngine();
  }

  /**
   * One frame from a window, whatever carried it. The desktop panel sends a window's app commands
   * over its own channel (`command` with the window's id); everything else arrives on the
   * WebSocket. Both end here, so an action behaves the same either way, and the events an action
   * produces go to that window's WebSocket — which is where the window reads them.
   */
  private async handleAppFrame(clientId: string, message: any): Promise<void> {
    switch (message?.type) {
      case 'send':
        this.chatSend(clientId, String(message.text ?? ''), message.attachments as AttachmentRef[] | undefined);
        break;
      case 'connector_connect': {
        void this.connectorAction(clientId, 'connect', String(message.connectorId ?? ''));
        break;
      }
      case 'connector_sign_in':
      case 'connector_signin': {
        void this.connectorAction(clientId, 'signIn', String(message.connectorId ?? ''));
        break;
      }
      case 'connector_mode': {
        void this.connectorMode(clientId, String(message.connectorId ?? ''), message.mode);
        break;
      }
      case 'connector_disconnect': {
        void this.connectorAction(clientId, 'disconnect', String(message.connectorId ?? ''));
        break;
      }
      case 'connectors_list': {
        void this.connectorsScreen(clientId);
        break;
      }
      case 'models_list': {
        void this.modelsScreen(clientId);
        break;
      }
      case 'model_set': {
        void this.modelSwitch(clientId, message);
        break;
      }
      case 'profiles_list': {
        void this.profilesScreen(clientId);
        break;
      }
      case 'profile_save': {
        void this.profileWrite(clientId, () =>
          this.profileStore?.save(String(message.name ?? ''), message.roles as never),
        );
        break;
      }
      case 'profile_rename': {
        void this.profileWrite(clientId, () =>
          this.profileStore?.rename(String(message.from ?? ''), String(message.to ?? '')),
        );
        break;
      }
      case 'profile_duplicate': {
        void this.profileWrite(clientId, () =>
          this.profileStore?.duplicate(String(message.from ?? ''), String(message.to ?? '')),
        );
        break;
      }
      case 'profile_save_current': {
        void this.profileSaveCurrent(String(message.name ?? ''), clientId);
        break;
      }
      case 'profile_import': {
        void this.profileImport(clientId);
        break;
      }
      case 'profile_apply': {
        void this.profileApply(String(message.name ?? ''), clientId);
        break;
      }
      case 'profile_delete': {
        void this.profileWrite(clientId, () => this.profileStore?.remove(String(message.name ?? '')));
        break;
      }
      case 'auth_list': {
        void this.authList(clientId);
        break;
      }
      case 'auth_login': {
        void this.authLogin(clientId, message);
        break;
      }
      case 'auth_reply': {
        const answer = {
          value: message.value === undefined ? undefined : String(message.value),
          cancelled: message.cancelled === true,
        };
        const owner = this.authOwner(clientId);
        const answeredByAccount = this.authManager?.reply(owner, String(message.flowId ?? ''), answer) === true;
        const answered =
          answeredByAccount ||
          this.connectorManager?.reply(owner, String(message.flowId ?? ''), answer) === true;
        // Another window's flow is none of this one's business.
        if (answered === false)
          this.wsServer.deliver(clientId, 'error', {
            code: 'auth_flow_not_found',
            message: 'That sign-in is not available.',
          });
        break;
      }
      case 'auth_logout': {
        void this.authLogout(clientId, String(message.providerId ?? ''));
        break;
      }
      case 'get_history': {
        const { messages, hasEarlier } = this.transcript.page(undefined);
        this.wsServer.deliver(clientId, 'history', { messages, hasEarlier });
        break;
      }
      case 'get_earlier': {
        const { messages, hasEarlier } = this.transcript.page(String(message.before ?? ''));
        this.wsServer.deliver(clientId, 'earlier', {
          before: String(message.before ?? ''),
          messages,
          hasEarlier,
        });
        break;
      }
      case 'ui_response': {
        const requestId = String(message.requestId ?? '');
        if (!requestId) break;
        const sent = this.shellSpawner.uiRespond(requestId, {
          value: message.value,
          confirmed: message.confirmed,
          cancelled: message.cancelled,
        });
        if (sent) this.wsServer.deliver(clientId, 'ask_resolved', { requestId });
        break;
      }
      case 'abort':
        this.shellSpawner.rpc('abort', {}, 60_000).catch((error) =>
          console.error(`[Daemon] abort falló: ${(error as Error).message}`),
        );
        break;
      default:
      break;
    }

  }


  /** Proxy approvals waiting for the user: one entry per ask, resolved once. */
  private readonly proxyApprovals = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();

  /** Asks the windows for a proxied write; nothing is sent unless the user allows it. */
  private approveProxied(preview: ApprovalPreview, signal: AbortSignal): Promise<boolean> {
    const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.proxyApprovals.delete(requestId);
        resolve(ok);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), 30_000);
      signal.addEventListener('abort', onAbort, { once: true });
      this.proxyApprovals.set(requestId, { resolve: finish, timer });
      const ask = {
        requestId,
        method: 'confirm',
        title: `${preview.connector}: ${preview.tool}`,
        message: `¿Permitir que el asistente use ${preview.connector} (${preview.tool})?`,
      };
      this.wsServer.broadcastApps('ask', ask);
      this.appChannel.broadcast('approval_requested', { ...preview, requestId });
    });
  }

  /** Changes a connector's mode; widening it is the app's decision, and the engine restarts. */
  private async connectorMode(clientId: string, connectorId: string, mode: unknown): Promise<void> {
    const manager = this.connectorManager;
    if (!manager || connectorId === '') return;
    const next = mode === 'read_write' ? 'read_write' : 'read_only';
    const refusal = manager.setMode(connectorId, next);
    if (refusal) {
      this.wsServer.deliver(clientId, 'error', { code: refusal.code, message: refusal.message });
      return;
    }
    await this.connectorsScreen();
    void this.restartEngine();
  }

  /** Answers `connectors_list` and the /connectors command with what the screen shows. */
  private async connectorsScreen(clientId?: string, open = false): Promise<void> {
    try {
      const connectors = this.connectorManager?.list() ?? [];
      const frame: Record<string, unknown> = { connectors };
      if (open) frame['open'] = true;
      if (clientId) this.wsServer.deliver(clientId, 'connectors', frame);
      else this.wsServer.broadcastApps('connectors', frame);
    } catch (error) {
      if (clientId)
        this.wsServer.deliver(clientId, 'error', {
          code: 'connectors_unavailable',
          message: `No se pudieron leer los conectores: ${(error as Error).message}`,
        });
    }
  }

  /** The models the picker shows: the engine's catalog grouped by account, what the assistant is
   * running now, and the profiles as quick picks. Everything else the engine reports about a
   * model (endpoints, headers, costs) stays here.
   */
  private async modelCatalog(): Promise<{
    current?: { provider: string; id: string; name: string; thinking?: string };
    groups: unknown[];
  }> {
    const state = (await this.shellSpawner.rpc('get_state', {}).catch(() => null)) as {
      data?: { model?: { provider?: string; id?: string; name?: string }; thinkingLevel?: string };
    } | null;
    const running = state?.data?.model;
    if (running?.provider && running.id) {
      this.currentModel = {
        provider: running.provider,
        id: running.id,
        name: running.name ?? running.id,
        ...(state?.data?.thinkingLevel ? { thinking: state.data.thinkingLevel } : {}),
      };
    }

    const answer = (await this.shellSpawner.rpc('get_available_models', {}).catch(() => null)) as {
      data?: { models?: unknown };
      models?: unknown;
    } | null;
    const raw = answer?.data?.models ?? answer?.models;
    const models = Array.isArray(raw) ? raw : [];
    // The window's message may carry files; whether they travel as pixels depends on the model.
    const runningEntry = models.find((entry: unknown) => {
      const model = entry as { provider?: unknown; id?: unknown };
      return model?.provider === running?.provider && model?.id === running?.id;
    }) as { input?: unknown } | undefined;
    if (this.currentModel)
      this.currentModel.images =
        Array.isArray(runningEntry?.input) && runningEntry.input.includes('image');

    const byProvider = new Map<string, { provider: string; name: string; models: unknown[] }>();
    for (const entry of models) {
      if (typeof entry !== 'object' || entry === null) continue;
      const model = entry as {
        provider?: unknown;
        id?: unknown;
        name?: unknown;
        reasoning?: unknown;
        input?: unknown;
      };
      if (typeof model.provider !== 'string' || typeof model.id !== 'string') continue;
      const group = byProvider.get(model.provider) ?? {
        provider: model.provider,
        name: model.provider,
        models: [],
      };
      group.models.push({
        provider: model.provider,
        id: model.id,
        name: typeof model.name === 'string' ? model.name : model.id,
        images: Array.isArray(model.input) && model.input.includes('image'),
        // Only a reasoning model offers thinking levels.
        ...(model.reasoning === true
          ? { thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'] }
          : {}),
      });
      byProvider.set(model.provider, group);
    }

    return {
      ...(this.currentModel ? { current: this.currentModel } : {}),
      groups: [...byProvider.values()],
    };
  }

  /** The profiles as quick picks: the orchestrator's model of each saved profile. */
  private quickPicks(): { name: string; model: string }[] {
    const { profiles } = this.profileStore?.list() ?? { profiles: [] };
    return profiles.flatMap((profile) => {
      const model = profile.roles?.orchestrator?.model;
      return typeof model === 'string' ? [{ name: profile.name, model }] : [];
    });
  }

  /** Answers `models_list` with the picker's view, and tells every window after a switch. */
  private async modelsScreen(clientId?: string): Promise<void> {
    try {
      const { current, groups } = await this.modelCatalog();
      // `images` is the daemon's own bookkeeping for attachments: the picker gets the four fields.
      const shown = current
        ? {
            provider: current.provider,
            id: current.id,
            name: current.name,
            ...(current.thinking ? { thinking: current.thinking } : {}),
          }
        : undefined;
      const frame: Record<string, unknown> = {
        ...(shown ? { current: shown } : {}),
        groups,
        profiles: this.quickPicks(),
      };
      if (this.pendingModel) frame['next'] = this.pendingModel;
      const activeProfile = this.profileStore?.list().active;
      if (activeProfile) frame['activeProfile'] = activeProfile;
      if (clientId) this.wsServer.deliver(clientId, 'models', frame);
      else this.wsServer.broadcastApps('models', frame);
    } catch (error) {
      if (clientId)
        this.wsServer.deliver(clientId, 'error', {
          code: 'models_unavailable',
          message: `No se pudieron leer los modelos: ${(error as Error).message}`,
        });
    }
  }

  /**
   * Switches the running model (and thinking level), keeps the choice and tells every window.
   * What the engine cannot do is answered here, before anything is sent: an unavailable model or a
   * thinking level the model does not offer leaves the assistant exactly as it was.
   */
  private async modelSwitch(
    clientId: string,
    message: { provider?: string; id?: string; thinking?: string },
  ): Promise<void> {
    const provider = String(message.provider ?? '');
    const id = String(message.id ?? '');
    if (!provider || !id) return;

    const { current, groups } = await this.modelCatalog();
    const models = (groups as { models: { provider: string; id: string; thinkingLevels?: string[] }[] }[]).flatMap(
      (group) => group.models,
    );
    const chosen = models.find((model) => model.provider === provider && model.id === id);
    if (!chosen) {
      this.wsServer.deliver(clientId, 'error', {
        code: 'model_unavailable',
        message: 'That model is not available. Connect its account in Accounts first.',
      });
      return;
    }
    const thinking = message.thinking;
    if (thinking && !(chosen.thinkingLevels ?? []).includes(thinking)) {
      this.wsServer.deliver(clientId, 'error', {
        code: 'thinking_unavailable',
        message: 'That model does not support that thinking level.',
      });
      return;
    }

    // An answer in flight keeps the model it started with: the choice waits for the next message.
    if (this.activeRun) {
      const name = (chosen as { name?: string }).name ?? id;
      this.pendingModel = { provider, id, name };
      this.pendingRoute = { model: `${provider}/${id}`, ...(thinking ? { thinking } : {}) };
      await this.modelsScreen();
      return;
    }

    const answer = (await this.shellSpawner
      .rpc('set_model', { provider, modelId: id, busy: false })
      .catch(() => null)) as { success?: boolean; error?: string } | null;
    if (answer && answer.success === false) {
      this.wsServer.deliver(clientId, 'error', {
        code: 'model_unavailable',
        message: 'That model is not available. Connect its account in Accounts first.',
      });
      return;
    }
    if (thinking) {
      await this.shellSpawner
        .rpc('set_thinking_level', { level: thinking, busy: false })
        .catch(() => null);
    }
    // The choice outlasts a restart: it becomes the assistant's saved default.
    const route: { model: string; thinking?: string } = { model: `${provider}/${id}` };
    if (thinking) route.thinking = thinking;
    else if (current?.thinking) route.thinking = current.thinking;
    await this.profileStore?.setDefaultModel(route as never).catch(() => undefined);
    await this.modelsScreen();
  }

  /** Sends the profiles screen: the store's view plus the models a role can point at. */
  private async profilesScreen(clientId: string | undefined, open = false): Promise<void> {
    if (!this.profileStore) return;
    try {
      const { profiles, active } = this.profileStore.list();
      const models = await this.modelOptions();
      const frame: Record<string, unknown> = {
        profiles,
        roles: this.profileStore.roles(),
        models,
        importable: this.profileStore.importable(),
      };
      if (active !== undefined) frame['active'] = active;
      if (open) frame['open'] = true;
      if (clientId) this.wsServer.deliver(clientId, 'profiles', frame);
      else this.wsServer.broadcastApps('profiles', frame);
    } catch (error) {
      if (clientId)
        this.wsServer.deliver(clientId, 'toast', {
          level: 'error',
          message: `No se pudieron leer los perfiles: ${(error as Error).message}`,
        });
    }
  }

  /**
   * Applies a profile: the store writes every file the engine routes from, every window sees the
   * new active profile, and the engine switches model. A running answer is not interrupted — the
   * switch waits for it, and a model whose account is not connected is reported instead of forced.
   */
  private async profileApply(name: string, clientId?: string): Promise<void> {
    if (!this.profileStore) return;
    let route: { model?: string; thinking?: string } | undefined;
    try {
      route = await this.profileStore.apply(name);
    } catch (error) {
      if (clientId)
        this.wsServer.deliver(clientId, 'toast', { level: 'warning', message: (error as Error).message });
      return;
    }
    // The engine switches first: by the time a window hears about the new active profile, the
    // model it names is already the one running.
    const switched = route?.model ? await this.switchModel(route) : true;
    await this.profilesScreen(undefined);
    await this.modelsScreen();
    if (!switched && clientId)
      this.wsServer.deliver(clientId, 'toast', {
        level: 'warning',
        message:
          "Profile applied. The main assistant keeps its current model until that model's account is connected.",
      });
  }

  /**
   * Saves the setup in use: the engine's current model and thinking level become the
   * orchestrator's route, and the subagents keep theirs.
   */
  private async profileSaveCurrent(name: string, clientId?: string): Promise<void> {
    if (!this.profileStore) return;
    try {
      const answer = (await this.shellSpawner.rpc('get_state', {})) as {
        data?: { model?: { provider?: string; id?: string }; thinkingLevel?: string };
      } | null;
      const state = answer?.data ?? {};
      const provider = state.model?.provider;
      const id = state.model?.id;
      // The engine reports the level as a string; the store validates it as its own union.
      const route =
        provider && id
          ? { model: `${provider}/${id}`, thinking: state.thinkingLevel as never }
          : undefined;
      await this.profileStore.saveCurrent(name, route);
      await this.profilesScreen(undefined);
    } catch (error) {
      if (clientId) this.wsServer.deliver(clientId, 'error', this.profileFailure(error));
    }
  }

  /** Imports another setup's profiles once, saying what was renamed and what still needs an account. */
  private async profileImport(clientId?: string): Promise<void> {
    if (!this.profileStore) return;
    try {
      const providers = (await this.authManager?.providers()) ?? [];
      const result = await this.profileStore.import(providers);
      if (clientId)
        this.wsServer.deliver(clientId, 'profiles_imported', {
          imported: result.imported,
          missingProviders: result.missingProviders,
        });
      await this.profilesScreen(undefined);
    } catch (error) {
      if (clientId) this.wsServer.deliver(clientId, 'error', this.profileFailure(error));
    }
  }

  /** Switches the engine's model, or parks the switch until the running turn settles. */
  private async switchModel(route: { model?: string; thinking?: string }): Promise<boolean> {
    if (!route.model) return false;
    if (this.activeRun) {
      this.pendingRoute = route;
      return true;
    }
    const split = splitModel(route.model);
    if (!split) return false;
    try {
      const answer = (await this.shellSpawner.rpc('set_model', {
        provider: split.provider,
        modelId: split.modelId,
        busy: false,
      })) as { success?: boolean } | null;
      if (answer && answer.success === false) return false;
      if (route.thinking) {
        await this.shellSpawner.rpc('set_thinking_level', { level: route.thinking, busy: false });
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Runs one profile write and answers with the refreshed screen, or a plain error. */
  private async profileWrite(clientId: string, write: () => Promise<void> | undefined): Promise<void> {
    try {
      await write();
      // Every window shows the same store, and editing the profile in use re-applies it.
      await this.profilesScreen(undefined);
      const active = this.profileStore?.list().active;
      if (active) {
        const saved = this.profileStore?.list().profiles.find((profile) => profile.name === active);
        if (saved) await this.profileApply(active, clientId);
      }
    } catch (error) {
      this.wsServer.deliver(clientId, 'error', this.profileFailure(error));
    }
  }

  /** A refused profile action: the store's own code and its plain-language sentence. */
  private profileFailure(error: unknown): { code: string; message: string } {
    if (error instanceof ProfileError) return { code: error.code, message: error.message };
    return { code: 'profile_failed', message: (error as Error)?.message ?? 'That did not work.' };
  }

  /**
   * The models a profile role may use: the engine's own catalog, stripped to what the screen needs
   * (provider, id, name, reasoning) so endpoints, headers and costs never travel. The engine is the
   * source of truth — models.json only covers a store that already exists.
   */
  private async modelOptions(): Promise<unknown[]> {
    try {
      const answer = (await this.shellSpawner.rpc('get_available_models', {})) as {
        success?: boolean;
        data?: { models?: unknown };
        models?: unknown;
      } | null;
      const models = answer?.data?.models ?? answer?.models;
      if (Array.isArray(models)) {
        return models.flatMap((raw: unknown) => {
          if (typeof raw !== 'object' || raw === null) return [];
          const model = raw as { provider?: unknown; id?: unknown; name?: unknown; reasoning?: unknown };
          if (typeof model.provider !== 'string' || typeof model.id !== 'string') return [];
          return [
            {
              provider: model.provider,
              id: model.id,
              name: typeof model.name === 'string' ? model.name : model.id,
              reasoning: model.reasoning === true,
            },
          ];
        });
      }
    } catch {
      // fall through to the store's file
    }
    const file = path.join(this.config.daemon.data_dir, 'gentle-ai', 'models.json');
    try {
      if (!existsSync(file)) return [];
      return toModelOptions(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return [];
    }
  }

  /** Answers `auth_list` with the providers the engine can sign into and their status. */
  private async authList(clientId: string, open = false): Promise<void> {
    if (!this.authManager) return;
    try {
      const providers = await this.authManager.providers();
      // Only the /login command opens the screen; a plain list is just data.
      this.wsServer.deliver(clientId, 'auth_providers', open ? { providers, open } : { providers });
    } catch (error) {
      this.wsServer.deliver(clientId, 'toast', {
        level: 'error',
        message: `No se pudieron leer las cuentas: ${(error as Error).message}`,
      });
    }
  }

  /** Starts a sign-in; the flow's prompts and news go to the window that asked. */
  private async authLogin(clientId: string, message: { providerId?: string; method?: string }): Promise<void> {
    if (!this.authManager) return;
    const refusal = this.authManager.start(
      this.authOwner(clientId),
      String(message.providerId ?? ''),
      (message.method === 'oauth' ? 'oauth' : 'api_key'),
      (event) => {
        // The manager already speaks the client protocol's frames; the window gets them flat.
        const { type, ...payload } = event as { type: string } & Record<string, unknown>;
        this.wsServer.deliver(clientId, type, payload);
        // A finished sign-in changes the accounts list, so the window sees it refreshed.
        if (type === 'auth_done') void this.authList(clientId);
      },
    );
    if (refusal) this.wsServer.deliver(clientId, 'error', { code: refusal.code, message: refusal.message });
  }

  /** Signs a provider out, reporting the outcome to the window that asked. */
  private async authLogout(clientId: string, providerId: string): Promise<void> {
    if (!this.authManager) return;
    try {
      const refusal = await this.authManager.logout(providerId);
      if (refusal) this.wsServer.deliver(clientId, 'error', { code: refusal.code, message: refusal.message });
      else await this.authList(clientId);
    } catch (error) {
      this.wsServer.deliver(clientId, 'toast', { level: 'error', message: (error as Error).message });
    }
  }

  /** Removes the workspace `mcp.json` the engine writes, when the guard cannot be enforced. */
  private removePlantedMcpJson(): void {
    const file = path.join(this.config.daemon.workspace, '.pi', 'mcp.json');
    try {
      if (!existsSync(file)) return;
      rmSync(file, { force: true });
      console.log(`[Daemon] Removed a planted mcp.json with the guard unenforceable: ${file}`);
    } catch (error) {
      console.log(`[Daemon] Could not remove the planted mcp.json (${file}): ${(error as Error).message}`);
    }
  }

  /**
   * The policy the approval guard reads: which connectors are approved and in which mode, the
   * files only the daemon may touch, and which servers its proxy already fronts. The lead entry
   * is the workspace's own `mcp.json`, because the engine writes it and the assistant must not.
   */
  private connectorPolicy(agentHome: string | undefined): Record<string, unknown> {
    const connectors: Record<string, { name: string; mode: string; readOnlyTools: string[] }> = {};
    const proxied: string[] = [];
    for (const [name, entry] of Object.entries(this.config.connectors ?? {})) {
      const connector = entry as { enabled?: boolean; mode?: string };
      if (!connector?.enabled) continue;
      connectors[name] = {
        name: name.charAt(0).toUpperCase() + name.slice(1),
        mode: connector.mode ?? 'read_only',
        readOnlyTools: [],
      };
      proxied.push(name);
    }

    const protectedPaths = [path.join(this.config.daemon.workspace, '.pi', 'mcp.json'), this.approvalGuardPath()];
    if (agentHome) protectedPaths.push(childGuardFile(agentHome));

    return { connectors, protectedPaths, proxied, builtin: ['computer'] };
  }

  /**
   * Puts the child guard in place and keeps it there while the engine runs. Returns false when it
   * cannot, so the caller starts the engine with subagents off instead of unprotected.
   */
  private superviseChildGuard(agentHome: string | undefined, guardPath: string): boolean {
    if (!agentHome) return false;
    const install = installChildGuardFile(agentHome, guardPath);
    if (!install.ok) {
      if (install.reason === 'cannot-be-written')
        console.log(`[Daemon] The child guard folder cannot be written (${install.file}), subagents are off`);
      else console.log(`[Daemon] The child guard cannot be put in place (${install.file}), subagents are off`);
      return false;
    }
    console.log(`[Daemon] Child guard installed: ${install.file}`);
    this.stopChildGuardWatch?.();
    this.stopChildGuardWatch = watchChildGuard(
      agentHome,
      guardPath,
      (line) => console.log(line),
      // With the guard unenforceable, a planted project mcp.json would reach the engine with no
      // one checking it: drop it and say why, once.
      () => this.removePlantedMcpJson(),
    );
    return true;
  }

  /** One owner object per window, so a flow answers only to the window that started it. */
  private authOwners = new Map<string, object>();

  /** The engine's home, kept so a restart can reuse it. */
  private engineHome: string | null = null;
  private restarting = false;
  /** True once the engine reported ready; only then is an unexpected exit worth respawning. */
  private engineReady = false;
  /** The restart currently running, so concurrent callers wait for the same one. */
  private restartInFlight: Promise<void> | null = null;
  /** How many times this daemon has started an engine; the first one has nothing to put back. */
  private engineStarts = 0;
  private restartPending = false;

  /** The connectors the user has added: the file the engine reads and the manager over it. */
  private connectorStore: ConnectorStore | null = null;
  private connectorManager: ConnectorManager | null = null;

  /** Files the user dropped on a window, and the prompt they belong to. */
  private uploads: UploadStore | null = null;

  /** A model chosen during a reply: it applies to the next message, not this one. */
  private pendingModel: { provider: string; id: string; name: string } | null = null;

  /** The model the assistant is running, as the last catalog read saw it. */
  private currentModel: {
    provider: string;
    id: string;
    name: string;
    thinking?: string;
    images?: boolean;
  } | null = null;

  /** A model switch waiting for the running turn to finish. */
  private pendingRoute: { model?: string; thinking?: string } | null = null;

  /** The assistant's own profiles and the files the engine routes models from. */
  private profileStore: ProfileStore | null = null;

  /** Sign-in flows for the accounts screen. */
  private authManager: AuthManager | null = null;

  /** The conversation as this daemon saw it, for windows that connect later. */
  private transcript = new Transcript('');

  /** Resolves once stop() finished, so a caller can wait for the daemon to be gone. */
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private stopping: Promise<void> | null = null;
  private stopped = false;

  /** Stops the child-guard watcher; set when the guard is in place. */
  private stopChildGuardWatch: (() => void) | null = null;

  /** Run activo: el conector que originó el prompt actual y su messageId. */
  private activeRun: { connectorId: string; messageId: string } | null = null;

  /** Fija el modelo del engine (GENTLE_DOT_ENGINE_MODEL, default nan/glm5.3-flash). */
  private configureEngineModel(): void {
    // No model named means the engine keeps whatever it has: forcing one would override the
    // user's own choice (and a saved profile) every time it starts.
    const model = process.env['GENTLE_DOT_ENGINE_MODEL'];
    if (!model) return;
    const slash = model.indexOf('/');
    if (slash <= 0) {
      console.warn(`[Daemon] GENTLE_DOT_ENGINE_MODEL inválido: ${model} (se espera provider/model)`);
      return;
    }
    const provider = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    this.shellSpawner
      .rpc('set_model', { provider, modelId })
      .then(() => console.log(`[Daemon] Engine model: ${model}`))
      .catch((error) => console.error(`[Daemon] set_model falló: ${(error as Error).message}`));
  }

  /**
   * Eventos del engine (pi RPC) → protocolo de conectores:
   * text_delta → message_delta · message_end (assistant) → message_done ·
   * tool_execution_start → activity · agent_settled → agent_state idle.
   * Todo se espeja al appChannel; lo dirigido al chat va al conector de origen.
   */
  private wireEngineEvents(): void {
    this.shellSpawner.on('engine-event', (event: Record<string, unknown>) => {
      const type = event['type'] as string;
      const origin = this.activeRun?.connectorId;

      switch (type) {
        case 'agent_start':
          // The engine is thinking until a tool runs; the window shows the difference.
          if (origin) this.wsServer.deliver(origin, 'agent_state', { state: 'thinking' });
          this.appChannel.broadcast('agent_state', { state: 'thinking' });
          break;

        case 'message_update': {
          const nested = event['assistantMessageEvent'] as { type?: string; delta?: string } | undefined;
          if (nested?.type === 'text_delta' && nested.delta && origin && this.activeRun) {
            const payload = { messageId: this.activeRun.messageId, delta: nested.delta };
            this.wsServer.deliver(origin, 'message_delta', payload);
            // Las ventanas necesitan el texto en vivo, no solo el mensaje final.
            this.appChannel.broadcast('message_delta', { ...payload, connectorId: origin });
          }
          break;
        }

        case 'message_end': {
          const message = event['message'] as { role?: string; content?: unknown } | undefined;
          if (message?.role !== 'assistant' || !origin || !this.activeRun) break;
          const text = this.extractText(message.content);
          this.transcript.add('assistant', text);
          if (text.trim() !== '') {
            this.wsServer.deliver(origin, 'message_done', {
              messageId: this.activeRun.messageId,
              text,
            });
            this.appChannel.broadcast('message_done', {
              messageId: this.activeRun.messageId,
              connectorId: origin,
              text,
            });
          }
          break;
        }

        case 'extension_ui_request': {
          const requestId = event['id'] as string | undefined;
          const method = event['method'] as string | undefined;
          // Only real questions travel; a status line or a toast has nothing to answer.
          if (!requestId || !method || !origin || !ASK_METHODS.has(method)) break;
          const ask = {
            requestId,
            method,
            // UI-bound text shows the product, never the branded names.
            title: presentText(String(event['title'] ?? '')),
            ...(event['message'] !== undefined ? { message: presentText(String(event['message'])) } : {}),
            ...(Array.isArray(event['options']) ? { options: (event['options'] as string[]).map(presentText) } : {}),
            ...(event['placeholder'] !== undefined ? { placeholder: presentText(String(event['placeholder'])) } : {}),
            ...(event['prefill'] !== undefined ? { prefill: presentText(String(event['prefill'])) } : {}),
          };
          this.wsServer.deliver(origin, 'ask', ask);
          break;
        }

        case 'tool_execution_start': {
          if (origin) this.wsServer.deliver(origin, 'agent_state', { state: 'working' });
          this.appChannel.broadcast('agent_state', { state: 'working' });
          const toolName = event['toolName'] as string | undefined;
          const toolCallId = event['toolCallId'] as string | undefined;
          if (toolName && origin && this.activeRun) {
            this.wsServer.deliver(origin, 'activity', {
              messageId: this.activeRun.messageId,
              activity: { id: toolCallId, kind: 'run', title: toolName, status: 'running' },
            });
          }
          break;
        }

        case 'agent_settled': {
          // Clear the run first: a deferred restart must not defer itself again.
          const deferred = this.restartPending;
          this.activeRun = null;
          this.restartPending = false;
          if (origin) this.wsServer.deliver(origin, 'agent_state', { state: 'idle' });
          this.appChannel.broadcast('agent_state', { state: 'idle' });
          if (this.pendingRoute) {
            const route = this.pendingRoute;
            this.pendingRoute = null;
            this.pendingModel = null;
            void this.switchModel(route).then(() => this.modelsScreen());
          }
          if (deferred) void this.restartEngine();
          break;
        }

        default:
          break;
      }

      // Espejo completo para la app de escritorio.
      this.appChannel.broadcast('engine_event', event);
    });
  }

  /** Extrae el texto de los content blocks de un mensaje del engine. */
  private extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block) => (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ''))
      .join('');
  }

  /**
   * Handle messages from bridges (WebSocket)
   */
  private async handleBridgeMessage(connectorId: string, message: any): Promise<void> {
    switch (message.type) {
      case 'send': {
        // A bridge may nest the body under `payload` or send it flat, the way the panel does.
        const payload = (message.payload ?? message) as { text?: string; attachments?: AttachmentRef[] };
        const text = payload?.text?.trim();
        if (!text) return;
        this.chatSend(connectorId, text, payload.attachments);
        break;
      }

      case 'abort': {
        this.shellSpawner.rpc('abort', {}, 60_000).catch((error) =>
          console.error(`[Daemon] abort falló: ${(error as Error).message}`));
        break;
      }

      case 'ui_response': {
        const payload = message.payload as { requestId?: string; value?: string; confirmed?: boolean; cancelled?: boolean };
        const requestId = payload?.requestId;
        if (!requestId) return;
        // A proxy approval answers here, before the engine's ask routing sees it.
        const pendingApproval = this.proxyApprovals.get(requestId);
        if (pendingApproval) {
          pendingApproval.resolve(payload.confirmed === true);
          return;
        }
        const sent = this.shellSpawner.uiRespond(requestId, {
          value: payload.value,
          confirmed: payload.confirmed,
          cancelled: payload.cancelled,
        });
        if (sent) this.wsServer.deliver(connectorId, 'ask_resolved', { requestId });
        break;
      }

      case 'channel_notify': {
        const payload = message.payload as { channelId: string; event: string; data: unknown };
        console.log(`[Daemon] Channel notify from ${connectorId}: ${payload.event} on ${payload.channelId}`);
        // Forward to app channel
        this.appChannel.broadcast('channel_notify', {
          connectorId,
          ...payload,
        });
        break;
      }

      case 'connector_event': {
        const payload = message.payload as { event: string; data: unknown };
        console.log(`[Daemon] Connector event from ${connectorId}: ${payload.event}`);
        this.appChannel.broadcast('connector_event', {
          connectorId,
          ...payload,
        });
        break;
      }

      case 'command': {
        const payload = message.payload as { commandId: string; action: string; params: Record<string, unknown> };
        await this.handleCommand(connectorId, payload);
        break;
      }

      case 'command_result': {
        // Forward to app channel
        this.appChannel.broadcast('command_result', {
          connectorId,
          ...message.payload,
        });
        break;
      }
    }
  }

  /**
   * Un prompt de un conector al engine. Con run activo de OTRO origen, el
   * mensaje va como steer (influye la corrida; la respuesta sigue yendo al
   * origen original). El 'send' rechazado por ocupado lo resuelve el bridge.
   */
  private chatSend(connectorId: string, text: string, attachments?: AttachmentRef[]): void {
    // A command, not a prompt: the engine never sees it and the window gets the accounts screen.
    if (text.trim() === '/login') {
      void this.authList(connectorId, true);
      return;
    }
    if (text.trim() === '/connectors') {
      void this.connectorsScreen(connectorId, true);
      return;
    }
    if (text.trim() === '/models') {
      void this.modelsScreen(connectorId);
      return;
    }
    if (text.trim() === '/profiles') {
      void this.profilesScreen(connectorId, true);
      return;
    }
    // Internal Gentle commands are the engine's own surface: a window or bridge never names them,
    // so a text that does is refused before the engine ever sees it.
    if (isBlockedInput(text)) {
      this.wsServer.deliver(connectorId, 'error', {
        code: 'unsupported',
        message: 'Ese comando no está disponible acá.',
      });
      return;
    }

    if (!this.shellSpawner.isReady()) {
      this.wsServer.deliver(connectorId, 'error', {
        code: 'engine_unavailable',
        message: 'El asistente no está disponible ahora.',
      });
      return;
    }

    // Files the user dropped on the window: described in the prompt, and attached as pixels only
    // when the running model can see them.
    let message = text;
    let images: { type: 'image'; mimeType: string; data: string }[] | undefined;
    if (attachments && attachments.length > 0 && this.uploads) {
      const resolved = this.uploads.resolve(attachments);
      if (resolved.ok && resolved.files.length > 0) {
        const composed = composePrompt(text, resolved.files, { images: this.currentModel?.images });
        message = composed.message;
        images = composed.images;
        this.uploads.consume(attachments);
      }
    }

    this.transcript.add('user', text);

    const params: Record<string, unknown> = { message };
    if (images && images.length > 0) params['images'] = images;
    if (this.activeRun) {
      params['streamingBehavior'] = 'steer';
      console.log(`[Daemon] steer desde ${connectorId} (run activo de ${this.activeRun.connectorId})`);
    } else {
      this.activeRun = {
        connectorId,
        messageId: `msg-${Date.now().toString(36)}`,
      };
      console.log(`[Daemon] prompt desde ${connectorId} (run ${this.activeRun.messageId})`);
    }

    this.shellSpawner
      .rpc('prompt', params)
      // The engine can refuse without throwing: a prompt with no account comes back as a failed
      // response, so both paths lead to the same answer for the window.
      .then((response) => {
        const failure = response as { success?: boolean; error?: string } | null;
        if (failure && failure.success === false) throw new Error(failure.error ?? 'prompt failed');
      })
      .catch((error) => {
      console.error(`[Daemon] prompt falló: ${(error as Error).message}`);
      // The window gets a plain answer: no account means "connect one", anything else "try again".
      this.activeRun = null;
      void this.reportPromptFailure(connectorId, (error as Error).message);

    });
  }

  /**
   * Handle command from bridge
   */
  private async handleCommand(connectorId: string, payload: { commandId: string; action: string; params: Record<string, unknown> }): Promise<void> {
    const { commandId, action, params } = payload;

    try {
      let result: unknown;

      switch (action) {

        case 'get_connectors': {
          result = this.registry.list().map(c => ({
            connectorId: c.connectorId,
            type: c.type,
            status: c.status,
            capabilities: c.capabilities,
          }));
          break;
        }

        case 'get_connector': {
          const { targetId } = params as { targetId: string };
          const connector = this.registry.get(targetId);
          result = connector ? {
            connectorId: connector.connectorId,
            type: connector.type,
            status: connector.status,
            capabilities: connector.capabilities,
            metadata: connector.metadata,
          } : null;
          break;
        }

        default:
          throw new Error(`Unknown command: ${action}`);
      }

      // Send result back to bridge
      this.wsServer.sendToConnector(connectorId, 'command_result', {
        commandId,
        success: true,
        result,
      });

    } catch (error) {
      this.wsServer.sendToConnector(connectorId, 'command_result', {
        commandId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Handle messages from app channel (desktop app)
   */
  private async handleAppMessage(clientId: string, message: AppMessage): Promise<void> {
    switch (message.type) {
      case 'approval_response': {
        const response = message.payload as { requestId?: string; approved?: boolean };
        const pendingApproval = response.requestId
          ? this.proxyApprovals.get(response.requestId)
          : undefined;
        if (pendingApproval) pendingApproval.resolve(response.approved === true);
        break;
      }

      case 'get_status': {
        // Handled by default handler
        break;
      }

      case 'get_connectors': {
        // Handled by default handler
        break;
      }

      case 'restart_connector': {
        const { connectorId } = message.payload as { connectorId: string };
        // TODO: Implement connector restart logic
        console.log(`[Daemon] Restart connector requested: ${connectorId}`);
        break;
      }
    }
  }

  /**
   * Marks a fresh default engine home as the engine's own, before the first spawn (S35.3, #13).
   * The engine writes the same record itself; a home that already has one is left untouched, and
   * one that only holds the daemon's earlier files is recovered by writing the marker.
   */
  private markEngineHome(agentHome: string): void {
    const marker = path.join(agentHome, '.gentle-shell-home');
    if (existsSync(marker)) return;
    try {
      mkdirSync(agentHome, { recursive: true, mode: 0o700 });
      const require = createRequire(import.meta.url);
      const version = (require('gentle-pi/package.json') as { version: string }).version;
      writeFileSync(marker, `${JSON.stringify({ createdBy: 'gentle-shell', version })}\n`);
    } catch (error) {
      // Never keep the engine from starting over a marker.
      console.error(`[Daemon] Could not mark the engine home (${agentHome}):`, error);
    }
  }

  /** The port the daemon listens on, for callers that health-check it. */
  get port(): number {
    return this.config.daemon.port;
  }

  /** The engine process this daemon supervises: its pid and whether it is still running. */
  get supervisor(): {
    pid: number | undefined;
    state: 'ready' | 'starting' | 'stopped';
    busy: boolean;
    restart(): Promise<void>;
  } {
    return {
      pid: this.shellSpawner.pid,
      // A restart takes a moment: reporting `ready` until the engine answers again lets a caller send
      // into the gap, where the message is dropped as `engine_unavailable`.
      state: this.stopped ? 'stopped' : this.shellSpawner.isReady() ? 'ready' : 'starting',
      busy: this.activeRun !== null,
      restart: () => this.restartEngine(),
    };
  }

  /** Same as stop(), for callers that think in terms of closing: idempotent. */
  close(): Promise<void> {
    return this.stop();
  }

  /**
   * Start the daemon
   */
  async start(): Promise<void> {
    console.log('[Daemon] Starting Gentle Dot Daemon...');
    console.log(`[Daemon] Config: ${this.config.daemon.host}:${this.config.daemon.port}`);

    // Start WebSocket server
    await this.wsServer.start();
    console.log('[Daemon] WebSocket server started');

    // Start App Channel
    await this.appChannel.start();
    console.log('[Daemon] App Channel started');

    this.transcript = new Transcript(path.join(this.config.daemon.data_dir, 'transcript.jsonl'));
    this.transcript.load();

    // Start Gentle Shell in RPC mode
    // Dev/smoke: skip the engine entirely (bridges and WS still work).
    if (process.env['GENTLE_DOT_NO_SHELL'] === '1') {
      console.log('[Daemon] GENTLE_DOT_NO_SHELL=1 — skipping Gentle Shell spawn');
    } else {
      try {
        await this.startEngine();
      } catch (error) {
        // A daemon stopped on purpose while its engine was still starting is not a failure: the
        // readiness timeout must not turn an orderly closure into a startup error.
        if (!this.stopping) throw error;
      }
    }

    // Register MCP servers based on config. Not awaited: a server that needs installing (or whose
    // package does not exist) must not keep the daemon from reporting itself ready.

    // Watch config for hot reload
    this.configWatcher = watchConfig(this.options.configPath || '', (newConfig) => {
      console.log('[Daemon] Config reloaded');
      this.config = newConfig;
      // TODO: Apply config changes (port changes require restart)
    });

    // Setup graceful shutdown
    this.setupSignalHandlers();

    console.log('[Daemon] Daemon started successfully');
  }


  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

    for (const signal of signals) {
      process.on(signal, () => {
        console.log(`[Daemon] Received ${signal}, shutting down...`);
        this.shutdown = true;
        this.stop().catch(console.error);
      });
    }
  }

  /**
   * Stop the daemon
   */
  /**
   * Starts the engine: assembles what it needs (home, sessions, guard, policy, sign-in) and spawns
   * it. Called at boot and again whenever credentials change.
   */
  private async startEngine(): Promise<void> {
    // Sign-in goes through the engine's own runtime: the accounts screen never sees a key it
    // cannot reach, and tests inject a fake one.
    this.authManager ??= new AuthManager({
      runtime: this.options.authRuntime ?? (() => createModelAuthRuntime(this.engineHome as string, process.cwd())),
      log: (line) => console.log(line),
    });

    // New credentials only take effect in a new engine, and a running turn finishes first.
    this.authManager.onCredentialsChanged = () => void this.restartEngine();

    // The engine's own home: the operator's choice when named, <data_dir>/agent otherwise. Only
    // the default is claimed for the engine (S35.3) — an overridden home is not ours to mark.
    const chosenHome = process.env['GENTLE_DOT_AGENT_HOME'];
    this.engineHome = chosenHome ?? path.join(this.config.daemon.data_dir, 'agent');
    if (!chosenHome) this.markEngineHome(this.engineHome);

    // The connectors live next to the engine's files: the store owns `mcp.json` and the guard,
    // the manager runs the sign-in and the mode changes on top of it. The daemon already
    // supervises the child guard, so the store is told not to write a second one.
    this.connectorStore ??= new ConnectorStore({
      dataDir: this.config.daemon.data_dir,
      agentHome: this.engineHome as string,
      workspace: this.config.daemon.workspace,
      guardPath: this.approvalGuardPath(),
      childGuard: false,
      // The connectors' secrets live in the app's own store, over its channel: the daemon never
      // keeps them, and without the app a connector that needs one fails closed.
      secrets: new AppSecretSource(this.appChannel),
      log: (line) => console.log(line),
    });
    // The app is asked for the connectors' integrity key at start, the way it always was, and the
    // store starts watching its files: what the assistant edits is put back while it runs, and the
    // user is told once each time it happens.
    void this.connectorStore.checkIntegrity();
    this.connectorStore.watch();
    this.connectorManager ??= new ConnectorManager({
      store: this.connectorStore,
      ...(this.options.connectorOAuth ? { oauth: this.options.connectorOAuth } : {}),
      ...(this.options.importHome ? { importHome: this.options.importHome } : {}),
      log: (line) => console.log(line),
    });
    // The manager replaces the store's revert hooks in its constructor, so the daemon talks to the
    // manager: the toast and the restart have to be attached after it exists.
    this.connectorManager.onBlocked = () => {
      this.wsServer.broadcastApps('toast', {
        level: 'warning',
        message: 'A change to your connectors was blocked.',
      });
      void this.connectorsScreen();
      // The engine was working with files the user did not approve: it comes back with the real ones.
      void this.restartEngine();
    };

    this.profileStore ??= new ProfileStore({
      configHome: path.join(this.config.daemon.data_dir, 'gentle-ai'),
      agentHome: this.engineHome as string,
      importPath: this.options.profilesImportPath ?? defaultImportPath(),
    });


    const shellConfig: ShellConfig = {
      home: this.config.daemon.workspace,
      agentHome: this.engineHome,
      engramProject: 'gentle-dot',
      mode: 'rpc',
      logLevel: this.config.daemon.log_level as any,
      noAutoSetup: this.options.noAutoSetup,
      engineCommand: this.options.engineCommand,
      // Sessions live next to the daemon's data so history survives an engine restart.
      sessionDir: path.join(this.config.daemon.data_dir, 'sessions'),
      extensions: [this.approvalGuardPath()],
    };
    // The connectors' store knows what is approved and in which mode; that is the policy.
    const storePolicy = this.connectorStore?.policy();
    shellConfig.policy = storePolicy
      ? (storePolicy as unknown as Record<string, unknown>)
      : this.connectorPolicy(shellConfig.agentHome);

    // The subagents of the assistant's engine load the guard from its extensions folder. If it
    // cannot be put there (or kept there), the engine runs with subagents off rather than
    // unprotected.
    // The engine never inherits the daemon's environment wholesale: it gets the isolated one
    // (own HOME/XDG, the user's Engram, no daemon-only secrets), the way the bundled daemon
    // always did. The spawner's own keys (project, policy, subagent gate) still win on top.
    const engineEnv = isolatedAgentEnv(process.env, this.config.daemon.data_dir, directAccess, undefined, {
      platform: process.platform,
    });
    engineEnv.GENTLE_PI_CONFIG_HOME = path.join(this.config.daemon.data_dir, 'gentle-ai');
    shellConfig.agentEnv = engineEnv as Record<string, string>;
    // The engine is about to read its server list: whatever the assistant changed is put back
    // first, and the report says so in the log.
    this.engineStarts += 1;
    if (this.engineStarts > 1) this.connectorStore.enforce();

    // The connectors reach the engine through the daemon: its server list points at our own MCP
    // endpoint, and the key is new on every launch so a stale file is visibly different.
    const proxyKey = randomBytes(24).toString('base64url');
    this.connectorStore.setProxy({
      url: `http://127.0.0.1:${this.config.daemon.port}/mcp`,
      key: proxyKey,
    });
    this.wsServer.mcpEndpoint = {
      key: proxyKey,
      handle: (req, res) => this.mcpProxy.handle(req, res),
    };

    const guardPath = shellConfig.extensions?.[0] ?? this.approvalGuardPath();
    if (!this.superviseChildGuard(shellConfig.agentHome, guardPath)) shellConfig.subagentsOn = false;

    await this.shellSpawner.start({
      config: shellConfig,
      cwd: this.config.daemon.workspace,
      onReady: () => {
        this.engineReady = true;
        console.log('[Daemon] Gentle Shell RPC ready');
        this.configureEngineModel();
        this.wireEngineEvents();
        // A window that is already open hears which model is running, without asking.
        void this.modelsScreen();
      },
      onError: (error) => console.error('[Daemon] Gentle Shell error:', error),
      onExit: (code: number | null, signal: NodeJS.Signals | null) => {
        console.log('[Daemon] Gentle Shell exited:', code, signal);
        try {
        } catch {}
        const wasReady = this.engineReady;
        this.engineReady = false;
        // The engine can end itself after editing its files. It is brought back from the user's
        // state, but never while we are stopping or already restarting: the exit that our own
        // stop() causes must not schedule a second restart.
        if (!wasReady || this.stopping || this.restarting || this.restartInFlight) return;
        // The engine died with a turn still open: it will never settle, so the restart would wait for
        // an event that cannot arrive. The run is over; the windows hear it too.
        this.activeRun = null;
        this.restartPending = false;
        this.appChannel.broadcast('agent_state', { state: 'idle' });
        setTimeout(() => {
          if (this.stopping || this.restarting || this.restartInFlight) return;
          void this.restartEngine();
        }, 100);
      },
    });

  }

  /**
   * Restarts the engine so it picks up new credentials. An answer in flight is not thrown away:
   * the restart waits for the turn to settle.
   */
  private async restartEngine(): Promise<void> {
    // A restart already in flight is shared, not skipped: a caller that asks while one runs must
    // wait for it, or it would read the old files while the engine has not come back yet.
    if (this.restartInFlight) return this.restartInFlight;
    if (!this.engineHome) return;
    if (this.activeRun) {
      this.restartPending = true;
      return;
    }
    this.restartPending = false;
    this.restartInFlight = this.runRestart().finally(() => {
      this.restartInFlight = null;
    });
    return this.restartInFlight;
  }

  private async runRestart(): Promise<void> {
    this.restarting = true;
    try {
      console.log('[Daemon] Restarting the engine to use the new credentials');
      await this.shellSpawner.stop();
      // A fresh spawner: the engine-event listeners must not stack on the old one.
      this.shellSpawner = new GentleShellSpawner();
      await this.startEngine();
    } catch (error) {
      console.error('[Daemon] Engine restart failed:', error);
    } finally {
      this.restarting = false;
    }
  }

  /**
   * Stops the daemon. Idempotent: closing twice, or closing while the app quits, stops it once
   * and every caller waits for the same promise.
   */
  async stop(): Promise<void> {
    this.stopping ??= this.doStop().finally(() => {
      this.stopped = true;
      this.resolveClosed();
    });
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    if (this.shutdown) {
      console.log('[Daemon] Shutting down...');
    }

    // Stop config watcher
    if (this.configWatcher) {
      this.configWatcher.close();
      this.configWatcher = null;
    }

    // Stop components in reverse order (the proxy's upstreams abort with their own signals).

    await this.shellSpawner.stop();
    console.log('[Daemon] Gentle Shell stopped');

    this.stopChildGuardWatch?.();
    this.stopChildGuardWatch = null;
    this.connectorStore?.close();

    await this.appChannel.stop();
    console.log('[Daemon] App Channel stopped');

    await this.wsServer.stop();
    console.log('[Daemon] WebSocket server stopped');

    // Clear registry
    this.registry.clear();
    console.log('[Daemon] Registry cleared');

    console.log('[Daemon] Daemon stopped');
    // The caller owns the process: exiting here made stop() unusable in tests (and in any
    // host that embeds the daemon) because it killed the whole process group.
  }

  /**
   * Get daemon status
   */
  getStatus(): object {
    return {
      running: !this.shutdown,
      config: {
        port: this.config.daemon.port,
        host: this.config.daemon.host,
      },
      connectors: this.registry.list().map(c => ({
        connectorId: c.connectorId,
        type: c.type,
        status: c.status,
        connectedAt: c.connectedAt,
      })),
      shell: {
        ready: this.shellSpawner.isReady(),
        pid: this.shellSpawner.getPid(),
      },
      appChannel: {
        clients: this.appChannel.getClientCount(),
      },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };
  }
}

/**
 * Create and start daemon from CLI options
 */
export async function createDaemon(options: DaemonOptions): Promise<Daemon> {
  const daemon = new Daemon(options);
  await daemon.start();
  return daemon;
}
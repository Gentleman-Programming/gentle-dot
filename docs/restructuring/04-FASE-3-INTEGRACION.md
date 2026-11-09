# 🔗 Fase 3: Integración Bridge ↔ Daemon (MCP Proxy + Native Approvals)

## 🎯 Objetivo

Conectar todos los componentes: Daemon Principal + 4 Conectores/Bridges + MCP Proxy + Testing E2E. **El daemon proxyea tráfico MCP (S25.4) y maneja approvals via dialogs nativos (S25.3).**

---

## 🏗️ Flujo de Integración

```text
┌─────────────────────────────────────────────────────────────────┐
│                    INTEGRACIÓN COMPLETA                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │   TELEGRAM  │    │    GMAIL    │    │      DISCORD        │ │
│  │  (Bridge)   │    │  (MCP Proxy)│    │      (MCP Proxy)    │ │
│  └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘ │
│         │                  │                       │             │
│         └──────────────────┼───────────────────────┘             │
│                            ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              DAEMON PRINCIPAL (puerto 4317)             │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │    │
│  │  │ WS Server   │  │ Connector    │  │ MCP Proxy      │  │    │
│  │  │ (Protocol)  │  │ Registry     │  │ (S25.4)        │  │    │
│  │  └─────────────┘  └──────────────┘  └────────────────┘  │    │
│  │  ┌─────────────────────────────────────────────────────┐  │    │
│  │  │ Gentle Shell RPC Spawner                            │  │    │
│  │  │ --mode rpc --home ~/.gentle-dot/agent               │  │    │
│  │  │ ENGRAM_PROJECT=gentle-dot                           │  │    │
│  │  │ --append-system-prompt (identidad sanitizada)       │  │    │
│  │  └─────────────────────────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                            │                                     │
│                            ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              WHATSAPP (Baileys + Meta Cloud)            │    │
│  │  ┌─────────────────┐         ┌───────────────────────┐  │    │
│  │  │   BAILEYS       │         │   META CLOUD API      │  │    │
│  │  │   (Bridge)      │         │   (MCP Proxy)         │  │    │
│  │  └─────────────────┘         └───────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔌 MCP Proxy (S25.4) - Daemon Frontend

```typescript
// packages/daemon/src/mcp-proxy.ts

interface MCPServerConfig {
  id: string;
  name: string;
  type: 'remote' | 'stdio';
  url?: string;           // para remote
  command?: string;       // para stdio
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  mode: 'read_only' | 'read_write';
  enabled: boolean;
}

class MCPProxy {
  private servers = new Map<string, MCPServerConfig>();
  private engineMcpConfig: any;

  registerServer(config: MCPServerConfig): void {
    this.servers.set(config.id, config);
    this.regenerateEngineMcpConfig();
  }

  unregisterServer(id: string): void {
    this.servers.delete(id);
    this.regenerateEngineMcpConfig();
  }

  private regenerateEngineMcpConfig(): void {
    // Generar mcp.json para el engine con URLs de proxy local
    this.engineMcpConfig = {
      mcpServers: {}
    };

    for (const [id, config] of this.servers) {
      if (!config.enabled) continue;
      
      this.engineMcpConfig.mcpServers[config.name] = {
        url: `http://127.0.0.1:${this.proxyPort}/mcp/${config.id}`,
        headers: {
          'Authorization': `Bearer ${this.generateEngineKey(config.id)}`
        }
      };
    }
    
    // Escribir a <agentHome>/mcp.json
    this.writeEngineMcpConfig();
  }

  // Proxy HTTP request to actual MCP server
  async proxyRequest(serverId: string, request: any): Promise<any> {
    const config = this.servers.get(serverId);
    if (!config) throw new Error(`MCP server ${serverId} not found`);

    // Inject auth headers for remote servers
    const headers = {
      ...request.headers,
      ...config.headers,
      'Authorization': `Bearer ${config.headers?.['Authorization'] || ''}`
    };

    // Filter tools by mode
    if (request.method === 'tools/list') {
      const result = await this.forwardRequest(config, request);
      result.tools = result.tools.filter(tool => 
        config.mode === 'read_write' || !this.isWriteTool(tool)
      );
      return result;
    }

    if (request.method === 'tools/call' && this.isWriteTool(request.params.name)) {
      if (config.mode === 'read_only') {
        throw new Error(`Server ${config.name} is read-only`);
      }
      // S25.3: Ask for approval before write actions
      await this.requestApproval(serverId, request.params);
    }

    return this.forwardRequest(config, request);
  }

  private async requestApproval(serverId: string, params: any): Promise<void> {
    // S25.3: Native approval via desktop app channel (S25.1)
    // Daemon sends approval request via app channel (Unix socketpair)
    // Desktop app shows native dialog with action preview
    // If denied or no app channel → refuse
  }

  private isWriteTool(toolName: string): boolean {
    const writeTools = ['send', 'create', 'update', 'delete', 'write', 'post', 'send_message', 'send_email'];
    return writeTools.some(w => toolName.toLowerCase().includes(w.toLowerCase()));
  }
}
```

---

## 🔐 App Channel (S25.1) - Unix Socketpair

```typescript
// packages/daemon/src/app-channel.ts

interface AppChannel {
  socket: any; // Unix domain socket
  authenticated: boolean;
}

class AppChannelManager {
  private channel: AppChannel | null = null;

  async initialize(socketFd: number): Promise<void> {
    // Recibir socketpair del desktop app via inherited fd
    this.channel = {
      socket: new net.Socket({ fd: socketFd }),
      authenticated: false
    };

    this.channel.socket.on('data', (data) => this.handleMessage(data));
    this.channel.socket.on('close', () => this.handleClose());
  }

  private async handleMessage(data: Buffer): Promise<void> {
    const msg = JSON.parse(data.toString());

    switch (msg.type) {
      case 'auth':
        // Validar clave heredada vs generada
        this.channel!.authenticated = this.verifyAppKey(msg.key);
        this.send({ type: 'auth_result', success: this.channel!.authenticated });
        break;

      case 'approval_request':
        if (!this.channel?.authenticated) {
          this.send({ type: 'approval_result', requestId: msg.requestId, success: false, reason: 'unauthenticated' });
          return;
        }
        // Mostrar dialog nativo via Tauri
        const result = await this.showNativeApproval(msg.action, msg.preview);
        this.send({ type: 'approval_result', requestId: msg.requestId, success: result.approved });
        break;

      case 'connector_action':
        if (!this.channel?.authenticated) return;
        // enable, disable, connect, disconnect, mode change
        await this.executeConnectorAction(msg.action, msg.params);
        break;

      case 'computer_register':
        if (!this.channel?.authenticated) return;
        // Registrar computer control helper
        break;
    }
  }

  private async showNativeApproval(action: string, preview: any): Promise<{approved: boolean}> {
    // Tauri native dialog - fuera del alcance del agente
    return { approved: false }; // placeholder
  }
}
```

---

## 🔄 Flujo de Integración

### Secuencia de Arranque

```bash
# 1. Iniciar Daemon Principal
GENTLE_SHELL_NO_AUTO_SETUP=1 \
DAEMON_PORT=4317 \
DAEMON_CONFIG=./packages/daemon/connectors.yaml \
pnpm --filter daemon start

# 2. Verificar Daemon saludable
curl http://localhost:4317/health
# {"status":"ok","uptime":123,"connectors":0,"agentState":"idle"}

# 3. Iniciar Bridges (orden independiente)
pnpm --filter @gentle-dot/connector-telegram start
pnpm --filter @gentle-dot/connector-gmail start
pnpm --filter @gentle-dot/connector-discord start
pnpm --filter @gentle-dot/connector-whatsapp start

# 4. Verificar registro en Daemon
curl http://localhost:4317/connectors
# [
#   {"connectorId":"telegram-1","type":"telegram","status":"ready","capabilities":[...]},
#   {"connectorId":"gmail-1","type":"gmail","status":"ready","capabilities":[...]},
#   {"connectorId":"discord-1","type":"discord","status":"ready","capabilities":[...]},
#   {"connectorId":"whatsapp-1","type":"whatsapp","status":"ready","capabilities":[...]}
# ]
```

---

## 🧪 Tests de Integración

### Test 1: Handshake Completo

```typescript
// test/integration/handshake.test.ts
test('Bridge conecta, handshake hello→ready, heartbeat ping→pong', async () => {
  const daemon = await startDaemon();
  const bridge = await startBridge('test-connector', 'telegram');
  
  await bridge.waitForReady();
  expect(bridge.sessionId).toBeDefined();
  expect(bridge.agentState).toBeDefined();
  
  const pong = await bridge.ping();
  expect(pong.seq).toBe(1);
  
  await bridge.stop();
  await daemon.stop();
});
```

### Test 2: Channel Notify E2E (Gmail → Telegram)

```typescript
// test/integration/channel-notify.test.ts
test('channel_notify desde Gmail llega a Telegram', async () => {
  const daemon = await startDaemon();
  const gmailBridge = await startBridge('gmail-1', 'gmail');
  const telegramBridge = await startBridge('telegram-1', 'telegram');
  
  await Promise.all([gmailBridge.waitForReady(), telegramBridge.waitForReady()]);
  
  // Gmail simula webhook de email nuevo
  gmailBridge.webhook.simulateNewEmail({
    from: 'test@example.com',
    subject: 'Test Email',
    snippet: 'Hello world'
  });
  
  // Verificar Telegram recibe notificación
  const notify = await telegramBridge.waitForChannelNotify(5000);
  expect(notify.text).toContain('Test Email');
  
  await Promise.all([gmailBridge.stop(), telegramBridge.stop(), daemon.stop()]);
});
```

### Test 3: MCP Proxy + Approval Flow

```typescript
// test/integration/mcp-proxy.test.ts
test('MCP proxy filtra tools por modo y pide approval para write', async () => {
  const daemon = await startDaemon();
  
  // Registrar MCP server read-only
  await daemon.mcpProxy.registerServer({
    id: 'test-readonly',
    name: 'Test ReadOnly',
    type: 'remote',
    url: 'http://mock-mcp:3000/mcp',
    mode: 'read_only',
    enabled: true
  });
  
  // Bridge conecta
  const bridge = await startBridge('test-1', 'telegram');
  await bridge.waitForReady();
  
  // List tools - solo read tools
  const tools = await bridge.sendMcpRequest('tools/list', {});
  expect(tools.every(t => !isWriteTool(t.name))).toBe(true);
  
  // Registrar server read-write
  await daemon.mcpProxy.registerServer({
    id: 'test-readwrite',
    name: 'Test ReadWrite',
    type: 'remote',
    url: 'http://mock-mcp:3000/mcp',
    mode: 'read_write',
    enabled: true
  });
  
  // Llamar tool write → debe pedir approval
  const result = await bridge.sendMcpRequest('tools/call', {
    name: 'send_email',
    arguments: { to: 'test@test.com', subject: 'Test' }
  });
  
  // Debe esperar approval (simulado via app channel)
  expect(result.approvalRequired).toBe(true);
  
  await Promise.all([bridge.stop(), daemon.stop()]);
});
```

### Test 4: Native Approval Flow (S25.3)

```typescript
// test/integration/native-approval.test.ts
test('Approval nativo via app channel para connector_command write', async () => {
  const daemon = await startDaemon();
  const whatsappBridge = await startBridge('whatsapp-1', 'whatsapp');
  
  await whatsappBridge.waitForReady();
  
  // Daemon envía comando write via connector_command
  const result = await daemon.sendConnectorCommand('whatsapp-1', {
    command: 'send_template',
    params: { to: '54911xxxxxxx', template: 'welcome', params: ['Juan'] }
  });
  
  // Debe pedir approval via app channel
  expect(result.approvalRequired).toBe(true);
  
  // Simular approval via app channel
  await daemon.appChannel.sendApprovalResult({
    requestId: result.requestId,
    approved: true
  });
  
  // Comando se ejecuta
  const finalResult = await daemon.waitForCommandResult(result.requestId);
  expect(finalResult.success).toBe(true);
  
  await Promise.all([whatsappBridge.stop(), daemon.stop()]);
});
```

### Test 5: Reconexión Automática

```typescript
// test/integration/reconnection.test.ts
test('Bridge se reconecta automáticamente si daemon cae', async () => {
  const daemon = await startDaemon();
  const bridge = await startBridge('test-1', 'telegram');
  
  await bridge.waitForReady();
  const originalSessionId = bridge.sessionId;
  
  // Matar daemon
  await daemon.kill();
  
  // Esperar reconexión
  await bridge.waitForReconnect(30000);
  
  // Nueva sesión
  expect(bridge.sessionId).not.toBe(originalSessionId);
  expect(bridge.isConnected).toBe(true);
  
  await bridge.stop();
});
```

---

## 📋 Checklist Integración

| Test | Comando | Estado |
| ------ | --------- | -------- |
| Handshake hello→ready | `pnpm test:integration handshake` | ⬜ |
| Heartbeat ping/pong | `pnpm test:integration heartbeat` | ⬜ |
| Channel notify E2E | `pnpm test:integration channel-notify` | ⬜ |
| Command routing | `pnpm test:integration connector-command` | ⬜ |
| Multi-bridge concurrent | `pnpm test:integration multi-bridge` | ⬜ |
| Reconexión auto | `pnpm test:integration reconnection` | ⬜ |
| Hot reload config | `pnpm test:integration hot-reload` | ⬜ |
| Graceful shutdown | `pnpm test:integration shutdown` | ⬜ |
| MCP Proxy read-only | `pnpm test:integration mcp-readonly` | ⬜ |
| MCP Proxy read-write + approval | `pnpm test:integration mcp-readwrite` | ⬜ |
| Native approval flow | `pnpm test:integration native-approval` | ⬜ |
| App channel auth | `pnpm test:integration app-channel` | ⬜ |

---

## 🚀 Scripts de Arranque

```json
// package.json (root)
{
  "scripts": {
    "daemon:start": "GENTLE_SHELL_NO_AUTO_SETUP=1 pnpm --filter daemon start",
    "bridge:telegram": "pnpm --filter @gentle-dot/connector-telegram start",
    "bridge:gmail": "pnpm --filter @gentle-dot/connector-gmail start",
    "bridge:discord": "pnpm --filter @gentle-dot/connector-discord start",
    "bridge:whatsapp": "pnpm --filter @gentle-dot/connector-whatsapp start",
    "start:all": "concurrently \"npm:daemon:start\" \"npm:bridge:telegram\" \"npm:bridge:gmail\" \"npm:bridge:discord\" \"npm:bridge:whatsapp\"",
    "test:integration": "pnpm --filter integration-tests test",
    "test:e2e": "pnpm test:integration -- --grep @e2e"
  }
}
```

---

## 🚫 Reglas de Oro (ver 15-REGLAS-ORO.md)

- **MCP Proxy en daemon** → filtra tools por modo, pide approval para write (S25.4)
- **App Channel** → Unix socketpair heredado del desktop app (S25.1)
- **Approvals nativos** → dialog nativo del desktop app (S25.3)
- **MCP Proxy filtra tools** → read_only vs read_write (S25.4)
- **Secrets en Keychain** → daemon lee via app channel (S25.5)
- **No modificar Gentle Shell** → solo spawnear en modo RPC
- **Engram global** → project `gentle-dot`
- **Identidad sanitizada** → system prompt inyectado

---

## 🔗 Próximo Paso

→ [05-FASE-4-TESTING.md](./05-FASE-4-TESTING.md)
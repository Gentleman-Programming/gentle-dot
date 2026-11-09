# 🎮 Conector Discord - Especificación Completa

## 🎯 Objetivo

Conector para Discord via **MCP Server Community** (S18). El daemon proxyea el tráfico MCP (S25.4). El bridge maneja Slash Commands y eventos de Discord.js.

---

## 📦 Información del Paquete

| Campo | Valor |
| ------- | ------- |
| Nombre | `@gentle-dot/connector-discord` |
| Versión | 1.0.0 |
| Entry Point | `src/index.ts` |
| Runtime | Node.js 20+ |
| Dependencia Principal | `discord.js@14+` |
| MCP Server | Community (`@discord/mcp` o similar) |

---

## 🏗️ Arquitectura

```text
packages/connectors/discord/
├── src/
│   ├── index.ts                 # Entry point → new DiscordBridge()
│   ├── discord-bridge.ts        # Extends BaseBridge
│   ├── bot/
│   │   ├── client.ts            # Discord.js Client wrapper
│   │   ├── deploy-commands.ts   # Slash commands deployment
│   │   └── events.ts            # Event handlers registration
│   ├── commands/
│   │   ├── index.ts             # Command registry
│   │   ├── status.ts            # /gentle-status
│   │   ├── send.ts              # /gentle-send
│   │   ├── connector.ts         # /gentle-connector
│   │   └── help.ts              # /gentle-help
│   ├── permissions/
│   │   ├── roles.ts             # Role-based permissions
│   │   └── checker.ts           # Permission validation
│   ├── handlers/
│   │   ├── interaction.ts       # interactionCreate
│   │   ├── message.ts           # messageCreate
│   │   ├── ready.ts             # ready event
│   │   └── error.ts             # error handling
│   └── types.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

> **Nota**: Según S18, Discord usa **MCP server community**. El daemon proxyea el tráfico MCP (S25.4). El bridge maneja Slash Commands y eventos de Discord.js v14+.

---

## ⚙️ Configuración

### connectors.yaml

```yaml
discord:
  enabled: true
  mode: "read_write"
  bot_token_env: "DISCORD_BOT_TOKEN"
  client_id_env: "DISCORD_CLIENT_ID"
  slash_commands: true
  guild_id_env: ""                # Guild ID para deploy instantáneo (dev)
  intents:
    - "Guilds"
    - "GuildMessages"
    - "MessageContent"
    - "DirectMessages"
    - "GuildMembers"              # Para roles/permisos
  permissions:
    admin_role_ids: []            # Role IDs con acceso admin
    operator_role_ids: []         # Role IDs operadores
    viewer_role_ids: []           # Role IDs solo lectura
    allowed_channels: []          # Channel IDs permitidos (vacío = todos)
    allowed_guilds: []            # Guild IDs permitidos (vacío = todos)
    owner_id_env: "DISCORD_OWNER_ID"  # User ID owner (admin total)
  presence:
    status: "online"              # online|idle|dnd|invisible
    activity: "Gentle System"     # Texto "Playing..."
```

### Variables de Entorno

```bash
# Obligatorias
DISCORD_BOT_TOKEN=xxx
DISCORD_CLIENT_ID=xxx

# Opcionales
DISCORD_GUILD_ID=xxx          # Para deploy commands dev
DISCORD_OWNER_ID=xxx          # User ID owner
DISCORD_WEBHOOK_URL=https://dominio.com/webhook/discord
LOG_LEVEL=info
DAEMON_URL=ws://localhost:4317
DISCORD_BRIDGE_TOKEN=discord-bridge-token
```

### Intents Requeridos

| Intent | Propósito |
| -------- | ----------- |
| `Guilds` | Info de servidores, canales, roles |
| `GuildMessages` | Leer mensajes en servidores |
| `MessageContent` | Acceso al contenido de mensajes |
| `DirectMessages` | DMs con el bot |
| `GuildMembers` | Para roles/permisos |

---

## 🤖 Discord.js Client Setup

```typescript
// packages/connectors/discord/src/bot/client.ts
import { Client, GatewayIntentBits, Partials } from 'discord.js';

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMembers, // Para roles/permisos
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.Reaction,
    ],
  });
}
```

---

## ⚡ Slash Commands

### Registro de Comandos

```typescript
// packages/connectors/discord/src/bot/deploy-commands.ts
const commands = [
  {
    name: 'gentle-status',
    description: 'Estado del sistema Gentle',
    options: []
  },
  {
    name: 'gentle-send',
    description: 'Enviar mensaje via Gentle',
    options: [
      { name: 'connector', type: 3, description: 'telegram|gmail|discord|whatsapp', required: true },
      { name: 'destino', type: 3, description: 'Usuario/canal destino', required: true },
      { name: 'mensaje', type: 3, description: 'Texto a enviar', required: true },
    ]
  },
  {
    name: 'gentle-connector',
    description: 'Gestionar conectores',
    options: [
      { name: 'accion', type: 3, description: 'list|status|restart', required: true },
      { name: 'connector', type: 3, description: 'Nombre del conector' },
    ]
  },
  {
    name: 'gentle-help',
    description: 'Ayuda de comandos Gentle',
    options: []
  }
];
```

### /gentle-status

```typescript
// packages/connectors/discord/src/commands/status.ts
import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { DiscordBridge } from '../discord-bridge';

export async function statusCommand(interaction: ChatInputCommandInteraction, bridge: DiscordBridge) {
  const status = await bridge.getSystemStatus();
  
  const embed = new EmbedBuilder()
    .setTitle('🤖 Gentle System Status')
    .setColor(status.daemon.connected ? 0x00ff00 : 0xff0000)
    .addFields(
      { name: '🔗 Daemon', value: status.daemon.connected ? 'Conectado' : 'Desconectado', inline: true },
      { name: '⏱️ Uptime', value: formatUptime(status.daemon.uptime), inline: true },
      { name: '🧠 Memoria', value: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`, inline: true },
      { name: '🌐 Conectores', value: status.connectors.map(c => `${c.type}: ${c.status}`).join('\n') }
    )
    .setTimestamp();
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
```

### /gentle-send

```typescript
// packages/connectors/discord/src/commands/send.ts
import { ChatInputCommandInteraction } from 'discord.js';
import { DiscordBridge } from '../discord-bridge';

export async function sendCommand(interaction: ChatInputCommandInteraction, bridge: DiscordBridge) {
  if (!await permissions.check(interaction.user.id, 'send')) {
    return interaction.reply({ content: '❌ Sin permisos para enviar', ephemeral: true });
  }
  
  const connector = interaction.options.getString('connector', true);
  const destino = interaction.options.getString('destino', true);
  const mensaje = interaction.options.getString('mensaje', true);
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    const result = await bridge.sendConnectorCommand(connector, 'send_message', {
      to: destino,
      text: mensaje
    });
    
    await interaction.editReply(`✅ Enviado via ${connector}: ${result.messageId}`);
  } catch (error) {
    await interaction.editReply(`❌ Error: ${error.message}`);
  }
}
```

### /gentle-connector

```typescript
// packages/connectors/discord/src/commands/connector.ts
export async function connectorCommand(interaction: ChatInputCommandInteraction, bridge: DiscordBridge) {
  const accion = interaction.options.getString('accion', true);
  const connector = interaction.options.getString('connector');
  
  switch (accion) {
    case 'list':
      const connectors = await bridge.getConnectors();
      return interaction.reply({ embeds: [formatConnectorList(connectors)], ephemeral: true });
    case 'status':
      if (!connector) return interaction.reply({ content: 'Especifica conector', ephemeral: true });
      const status = await bridge.getConnectorStatus(connector);
      return interaction.reply({ embeds: [formatConnectorStatus(status)], ephemeral: true });
    case 'restart':
      if (!connector) return interaction.reply({ content: 'Especifica conector', ephemeral: true });
      await bridge.restartConnector(connector);
      return interaction.reply({ content: `🔄 Reiniciando ${connector}...`, ephemeral: true });
  }
}
```

---

## 🔐 Permisos

### Sistema de Roles

```typescript
// packages/connectors/discord/src/permissions/roles.ts
interface PermissionConfig {
  adminRoleIds: string[];      // Acceso total
  operatorRoleIds: string[];   // Enviar, ver status
  viewerRoleIds: string[];     // Solo ver status
  allowedChannels: string[];   // Canales permitidos (vacío = todos)
  allowedGuilds: string[];     // Servidores permitidos (vacío = todos)
}

const defaultPermissions: PermissionConfig = {
  adminRoleIds: [],
  operatorRoleIds: [],
  viewerRoleIds: [],
  allowedChannels: [],
  allowedGuilds: []
};
```

### Checker

```typescript
// packages/connectors/discord/src/permissions/checker.ts
export async function checkPermission(
  user: User,
  member: GuildMember | null,
  permission: 'admin' | 'operator' | 'viewer' | 'send'
): Promise<boolean> {
  // 1. Owner del bot = admin
  if (user.id === process.env.DISCORD_OWNER_ID) return true;
  
  // 2. Verificar roles
  const config = getPermissionConfig();
  const roleIds = member?.roles.cache.map(r => r.id) || [];
  
  switch (permission) {
    case 'admin':
      return roleIds.some(id => config.adminRoleIds.includes(id));
    case 'operator':
    case 'send':
      return roleIds.some(id => config.operatorRoleIds.includes(id));
    case 'viewer':
      return roleIds.some(id => config.viewerRoleIds.includes(id)) ||
             roleIds.some(id => config.operatorRoleIds.includes(id)) ||
             roleIds.some(id => config.adminRoleIds.includes(id));
  }
  
  return false;
}
```

---

## 📡 Event Handlers

### ready

```typescript
// packages/connectors/discord/src/handlers/ready.ts
export async function onReady(client: Client, bridge: DiscordBridge) {
  logger.info(`🤖 Discord bot ready: ${client.user?.tag}`);
  
  // Deploy slash commands
  await deployCommands(client);
  
  // Notificar daemon
  bridge.sendConnectorEvent({
    type: 'bot_ready',
    user: client.user?.tag,
    guilds: client.guilds.cache.size,
    users: client.users.cache.size
  });
  
  // Heartbeat interno
  setInterval(() => {
    bridge.sendConnectorEvent({ type: 'heartbeat', timestamp: Date.now() });
  }, 30000);
}
```

### messageCreate

```typescript
// packages/connectors/discord/src/handlers/message.ts
export async function onMessage(message: Message, bridge: DiscordBridge) {
  if (message.author.bot) return;
  
  // Menciones al bot
  if (message.mentions.has(client.user!)) {
    const content = message.content.replace(`<@${client.user!.id}>`, '').trim();
    await handleMention(message, content, bridge);
    return;
  }
  
  // DMs directos
  if (message.channel.type === ChannelType.DM) {
    await handleDM(message, bridge);
    return;
  }
}
```

### interactionCreate

```typescript
// packages/connectors/discord/src/handlers/interaction.ts
export async function onInteraction(interaction: Interaction, bridge: DiscordBridge) {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction, bridge);
  } else if (interaction.isButton()) {
    await handleButton(interaction, bridge);
  } else if (interaction.isModalSubmit()) {
    await handleModal(interaction, bridge);
  }
}
```

---

## 🔌 Protocolo Bridge ↔ Daemon

### Capabilities

```typescript
const capabilities = [
  'channel_notify',        // Notificaciones a canales/DMs
  'message_send',          // Envío de mensajes
  'connector_command',     // Slash commands admin
  'slash_commands',        // Registro/ejecución comandos
  'permission_management', // Roles/permisos
  'guild_management'       // Info servidores/canales
];
```

### Eventos Emitidos (Bridge → Daemon)

| Evento | Payload | Descripción |
| -------- | --------- | ------------- |
| `message_received` | `{guildId, channelId, userId, content, isDM}` | Mensaje entrante |
| `slash_command` | `{command, options, userId, guildId}` | Slash command ejecutado |
| `button_click` | `{customId, userId, guildId}` | Botón presionado |
| `modal_submit` | `{customId, fields, userId}` | Modal enviado |
| `bot_ready` | `{user, guilds, users}` | Bot listo |
| `guild_join` | `{guildId, name, memberCount}` | Bot añadido a servidor |
| `guild_leave` | `{guildId}` | Bot removido de servidor |

### Comandos Recibidos (Daemon → Bridge)

| Comando | Params | Respuesta |
| --------- | -------- | ----------- |
| `send_message` | `{channelId, content, embeds?, components?}` | `{messageId}` |
| `send_dm` | `{userId, content, embeds?}` | `{messageId}` |
| `broadcast` | `{guildId, content, roleId?}` | `{sentCount}` |
| `get_channels` | `{guildId}` | `{channels: Channel[]}` |
| `get_guilds` | `{}` | `{guilds: Guild[]}` |
| `get_member` | `{guildId, userId}` | `{member: Member}` |
| `assign_role` | `{guildId, userId, roleId}` | `{success}` |
| `create_thread` | `{channelId, name, message}` | `{threadId}` |

---

## ✅ Checklist Implementación

| Componente | Archivo | Tests | Estado |
| ------------ | --------- | ------- | -------- |
| Entry point | `src/index.ts` | ⬜ | ⬜ |
| DiscordBridge | `src/discord-bridge.ts` | ⬜ | ⬜ |
| Client setup | `src/bot/client.ts` | ⬜ | ⬜ |
| Events | `src/bot/events.ts` | ⬜ | ⬜ |
| Deploy commands | `src/bot/deploy-commands.ts` | ⬜ | ⬜ |
| /gentle-status | `src/commands/status.ts` | ⬜ | ⬜ |
| /gentle-send | `src/commands/send.ts` | ⬜ | ⬜ |
| /gentle-connector | `src/commands/connector.ts` | ⬜ | ⬜ |
| /gentle-help | `src/commands/help.ts` | ⬜ | ⬜ |
| Permissions | `src/permissions/roles.ts` | ⬜ | ⬜ |
| Checker | `src/permissions/checker.ts` | ⬜ | ⬜ |
| Interaction handler | `src/handlers/interaction.ts` | ⬜ | ⬜ |
| Message handler | `src/handlers/message.ts` | ⬜ | ⬜ |
| Ready handler | `src/handlers/ready.ts` | ⬜ | ⬜ |
| Error handler | `src/handlers/error.ts` | ⬜ | ⬜ |
| Config validation | `src/config.ts` | ⬜ | ⬜ |

---

## 🧪 Tests Clave

```typescript
// test/commands/status.test.ts
describe('/gentle-status', () => {
  it('muestra estado daemon conectado', async () => {
    bridge.setDaemonConnected(true);
    const reply = await executeSlashCommand('gentle-status', mockInteraction);
    expect(reply.embeds[0].fields).toContainEqual(
      expect.objectContaining({ name: '🔗 Daemon', value: 'Conectado' })
    );
  });
});

// test/permissions.test.ts
describe('PermissionChecker', () => {
  it('owner tiene admin', async () => {
    process.env.DISCORD_OWNER_ID = '123';
    const result = await checkPermission({id: '123'}, mockMember, 'admin');
    expect(result).toBe(true);
  });
  
  it('rol operator permite send', async () => {
    const member = mockMember(['operator-role-id']);
    config.operatorRoleIds = ['operator-role-id'];
    const result = await checkPermission({id: '456'}, member, 'send');
    expect(result).toBe(true);
  });
});
```

---

## 🚀 Despliegue

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build
CMD ["node", "dist/index.js"]
```

### Variables Requeridas

```bash
# Obligatorias
DISCORD_BOT_TOKEN=xxx
DISCORD_CLIENT_ID=xxx

# Opcionales
DISCORD_GUILD_ID=xxx
DISCORD_OWNER_ID=xxx
DISCORD_WEBHOOK_URL=https://dominio.com/webhook/discord
LOG_LEVEL=info
DAEMON_URL=ws://localhost:4317
DISCORD_BRIDGE_TOKEN=discord-bridge-token
```

### Deploy Commands (Development)

```bash
# Deploy a guild específica (instantáneo)
DISCORD_GUILD_ID=xxx pnpm run deploy:commands

# Deploy global (tarda ~1h)
pnpm run deploy:commands:global
```

---

## 📚 Referencias

- [Bridge Protocol v1](./10-PROTOCOLO-BRIDGE-DAEMON.md)
- [Configuración Central](./11-CONFIGURACION.md)
- [Testing Plan](./12-TESTING-PLAN.md)
- [Reglas de Oro](./15-REGLAS-ORO.md)
- [gentle-dot Philosophy](./gentle-dot.md) - S3: Gentle Shell unchanged, S4: Identity sanitized, S12: Assistant brings own instance, S18: Connectors via MCP, S23: Engram global project `gentle-dot`, S25: Connector enforcement outside agent, S25.4: MCP proxy filters tools by mode
- [Discord.js Guide](https://discordjs.guide/)

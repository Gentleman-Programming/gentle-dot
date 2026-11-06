/**
 * Telegram Bridge - Extends BaseBridge from @gentle-dot/bridges-base
 * Uses grammY for Telegram Bot API
 */

import { Bot, Context, InlineKeyboard } from 'grammy';
import { readFileSync } from 'node:fs';
import { BaseBridge, brandInbound, type BridgeConfig, type BridgeStatus, type HelloPayload, type ReadyPayload, type ChannelNotifyPayload, type ConnectorEventPayload, type CommandPayload, type CommandResultPayload, type BridgeMessage } from '@gentle-dot/bridges-base';
import { NicknameStore } from './storage/nickname-store.js';
import { loadConfig, Config } from './config.js';
import { splitMessage, telegramDownloader } from './utils.js';
import type { AttachmentRef } from '@gentle-dot/protocol';

const TELEGRAM_TEXT_LIMIT = 4096;
/** The branded label the contract prepends to every inbound (#48). */
const CHANNEL_LABEL = '📱 [Telegram] ';
const DRAFT_REFRESH_MS = 20000;
const MAX_VOICE_AUDIO = 1024 * 1024; // ~1MB base64
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const MAX_CHOICES = 99;
const BUSY_STATES = ['thinking', 'working', 'needs_you'];
const SEND_REFUSALS = new Set(['no_account', 'agent_unavailable', 'command_failed', 'unsupported']);
const UNREACHABLE = 'Gentle Dot no está disponible ahora.';

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
};

interface Upload {
  uploadId: string;
  name: string;
  size: number;
  mime: string;
  data: string;
}

interface UploadedFile extends Upload {
  path: string;
}

interface IncomingFile {
  fileId: string;
  name: string;
  size?: number;
}

interface PendingAsk {
  ask: {
    requestId: string;
    method: string;
    title: string;
    message?: string;
    options?: string[];
  };
  chatId: number;
  messageId?: number;
}

type UploadFn = (file: Upload) => Promise<UploadedFile>;

export interface TelegramBridgeOptions {
  config: Config;
  log(message: string): void;
  download?(filePath: string): Promise<Buffer>;
  upload?(file: Upload): Promise<UploadedFile>;
}

export class TelegramBridge extends BaseBridge {
  private bot: Bot;
  private nicknameStore: NicknameStore;
  private options: TelegramBridgeOptions;
  private logFn: (message: string) => void;

  // Telegram-specific state
  private chatId: number;
  private turn: {
    chatId: number;
    draftId: number;
    draftText: string;
    sawBusy: boolean;
    refresh: NodeJS.Timeout;
  } | undefined;
  private asks = new Map<number, PendingAsk>();
  private nextAskKey = 1;
  private awaitingInput: number | undefined;
  private agentState = 'idle';
  private canTranscribe = false;
  private transcriptions = new Map<string, number>();
  private nextVoiceId = 1;
  private downloadFn: (filePath: string) => Promise<Buffer>;
  private uploadFn: UploadFn;

  constructor(options: TelegramBridgeOptions) {
    // The daemon access key (GENTLE_DOT_TOKEN_FILE) authenticates the WS
    // handshake; the Telegram bot token is never the daemon credential.
    let daemonToken: string;
    try {
      daemonToken = readFileSync(options.config.tokenFile, 'utf8').trim();
    } catch {
      throw new Error(`Cannot read the daemon token file: ${options.config.tokenFile}`);
    }
    if (!daemonToken) {
      throw new Error(`The daemon token file is empty: ${options.config.tokenFile}`);
    }

    const bridgeConfig: BridgeConfig = {
      daemonUrl: options.config.daemonUrl,
      connectorId: (options.config as any).connectorId ?? 'telegram',
      connectorType: 'telegram',
      token: daemonToken,
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'nickname_management',
        'multi_chat',
        'voice_transcription',
      ],
      metadata: {
        version: '1.0.0',
        features: ['nickname_management', 'multi_chat'],
      },
    };

    super(bridgeConfig);

    this.options = options;
    this.logFn = options.log;
    this.downloadFn = options.download ?? telegramDownloader(options.config.botToken);
    this.uploadFn = options.upload!;

    // Initialize bot
    this.bot = new Bot(options.config.botToken, {
      client: { timeoutSeconds: 60 },
    });
    this.nicknameStore = new NicknameStore(options.config.nicknameDb);

    // Allowed users
    this.chatId = [...options.config.allowedUsers][0] ?? 0;

    this.setupBot();
  }

  private setupBot(): void {
    this.bot.use((ctx, next) => (this.allowed(ctx) ? next() : undefined));
    this.bot.command(['start', 'help'], (ctx) => this.showMenu(ctx.chat!.id, HELP));
    this.bot.command('menu', (ctx) => this.showMenu(ctx.chat!.id, 'Tu menú de acciones:'));
    this.bot.command('stop', (ctx) => this.stopChat(ctx.chat!.id));
    this.bot.command('cancel', (ctx) => this.cancelInput(ctx.chat!.id));
    this.bot.callbackQuery(/^a:(\d+):(y|n|c|\d+)$/, (ctx) =>
      this.onButton(ctx, Number(ctx.match[1]), String(ctx.match[2])),
    );
    this.bot.on('message:text', (ctx) => this.onText(ctx.chat!.id, ctx.message.text, ctx.from!.id.toString()));
    this.bot.on('message:voice', (ctx) => this.onVoice(ctx.chat!.id, ctx.message.voice.file_id));
    this.bot.on('message:document', (ctx) => {
      const { document } = ctx.message;
      const name = document.file_name || `file-${document.file_unique_id}`;
      return this.onFile(ctx.chat!.id, { fileId: document.file_id, name, size: document.file_size }, ctx.message.caption);
    });
    this.bot.on('message:photo', (ctx) => {
      const photo = ctx.message.photo.at(-1);
      if (!photo) return;
      const name = `photo-${photo.file_unique_id}.jpg`;
      return this.onFile(ctx.chat!.id, { fileId: photo.file_id, name, size: photo.file_size }, ctx.message.caption);
    });
    this.bot.on('message:video', (ctx) => {
      const { video } = ctx.message;
      const name = video.file_name || `video-${video.file_unique_id}.mp4`;
      return this.onFile(ctx.chat!.id, { fileId: video.file_id, name, size: video.file_size }, ctx.message.caption);
    });
    this.bot.on('message:audio', (ctx) => {
      const { audio } = ctx.message;
      const extension = AUDIO_EXTENSIONS[audio.mime_type ?? ''] ?? 'audio';
      const name = audio.file_name || `audio-${audio.file_unique_id}.${extension}`;
      return this.onFile(ctx.chat!.id, { fileId: audio.file_id, name, size: audio.file_size }, ctx.message.caption);
    });
    this.bot.catch((error) => this.logFn(`telegram update failed: ${(error.error as Error).message}`));
  }

  private allowed(ctx: Context): boolean {
    const chat = ctx.chat;
    if (chat?.type !== 'private' || !this.options.config.allowedUsers.has(chat.id)) return false;
    if (ctx.from && !this.options.config.allowedUsers.has(ctx.from.id)) return false;
    this.chatId = chat.id;
    return true;
  }

  // ============ BaseBridge Abstract Methods ============

  async onReady(): Promise<void> {
    this.logFn('Telegram bridge ready - bot started');
    await this.hello();
  }

  async onStop(): Promise<void> {
    this.logFn('Telegram bridge stopping');
    this.bot.stop();
    this.endTurn();
    this.asks.clear();
    this.awaitingInput = undefined;
    this.transcriptions.clear();
  }

  // ============ BaseBridge Overrides ============

  protected override sendHello(): void {
    const payload: HelloPayload = {
      token: this.config.token,
      protocol: 1,
      capabilities: this.config.capabilities,
      connectorType: this.config.connectorType,
      connectorId: this.config.connectorId,
      metadata: this.config.metadata,
    };
    this.send('hello', payload);
  }

  protected override handleConnectorMessage(message: BridgeMessage): void {
    this.dispatch(message);
  }

  private dispatch(message: { type: string; payload: unknown }): void {
    const turn = this.turn;
    switch (message.type) {
      case 'ready': {
        const ready = message.payload as ReadyPayload;
        this.agentState = ready.agentState;
        this.canTranscribe = ready.features?.includes('voice_transcription') ?? false;
        this.emit('onReady', ready.sessionId);
        break;
      }
      case 'voice_transcript': {
        const payload = message.payload as { requestId: string; text: string };
        const chatId = this.transcriptions.get(payload.requestId);
        this.transcriptions.delete(payload.requestId);
        if (chatId === undefined) return;
        const text = payload.text.trim();
        if (text === '') {
          void this.reply(chatId, 'No pude escuchar nada en esa nota de voz.');
          return;
        }
        void this.reply(chatId, `🎙️ ${text}`);
        void this.onText(chatId, text, '');
        break;
      }
      case 'voice_unavailable': {
        const payload = message.payload as { requestId: string; reason: string };
        const chatId = this.transcriptions.get(payload.requestId);
        this.transcriptions.delete(payload.requestId);
        if (chatId !== undefined) void this.reply(chatId, payload.reason);
        break;
      }
      case 'agent_state': {
        const payload = message.payload as { state: string };
        this.agentState = payload.state;
        if (!turn) return;
        if (BUSY_STATES.includes(this.agentState)) {
          turn.sawBusy = true;
        } else if (turn.sawBusy && (this.agentState === 'idle' || this.agentState === 'error')) {
          this.endTurn();
        }
        break;
      }
      case 'activity': {
        const payload = message.payload as { activity: { status: string; title: string } };
        if (!turn || payload.activity?.status !== 'running') return;
        turn.draftText = `${payload.activity.title}…`;
        void this.draft(turn);
        break;
      }
      case 'message_done': {
        if (!turn) return;
        const payload = message.payload as { error?: string; text: string; stopped?: boolean };
        const text = payload.error ?? payload.text;
        if (text.trim() === '') {
          if (payload.stopped) void this.reply(turn.chatId, 'Detenido.');
          return;
        }
        for (const chunk of splitMessage(text)) void this.reply(turn.chatId, chunk);
        break;
      }
      case 'toast': {
        const payload = message.payload as { level: string; message: string };
        if (turn && payload.level !== 'info') void this.reply(turn.chatId, `⚠️ ${payload.message}`);
        break;
      }
      case 'error': {
        const payload = message.payload as { code: string; message: string };
        if (!turn) return;
        if (SEND_REFUSALS.has(payload.code) && !BUSY_STATES.includes(this.agentState)) this.endTurn();
        void this.reply(turn.chatId, `⚠️ ${payload.message}`);
        break;
      }
      case 'ask': {
        const payload = message.payload as { requestId: string; method: string; title: string; message?: string; options?: string[] };
        void this.showAsk(payload);
        break;
      }
      case 'ask_resolved': {
        const payload = message.payload as { requestId: string };
        void this.resolveAsk(payload.requestId);
        break;
      }
      case 'channel_notify': {
        this.emit('onChannelNotify', message.payload as ChannelNotifyPayload);
        break;
      }
      case 'connector_event': {
        this.emit('onConnectorEvent', message.payload as ConnectorEventPayload);
        break;
      }
      case 'command': {
        const payload = message.payload as CommandPayload;
        void this.handleCommand(payload);
        break;
      }
      case 'command_result': {
        this.emit('onCommandResult', message.payload as CommandResultPayload);
        break;
      }
      default:
        return;
    }
  }

  // ============ Telegram-Specific Methods ============

  private takeTranscription(requestId: string): number | undefined {
    const chatId = this.transcriptions.get(requestId);
    this.transcriptions.delete(requestId);
    return chatId;
  }

  private async showAsk(ask: { requestId: string; method: string; title: string; message?: string; options?: string[] }): Promise<void> {
    if (typeof ask.requestId !== 'string' || typeof ask.title !== 'string') throw new Error('malformed ask');
    for (const pending of this.asks.values()) if (pending.ask.requestId === ask.requestId) return;

    const chatId = this.turn?.chatId ?? this.chatId;
    const head = ask.message ? `${ask.title}\n\n${ask.message}` : ask.title;

    if (ask.method === 'app') {
      await this.reply(chatId, this.fitMessage(head, '\n\nAprueba esto en la app de Gentle Dot.'));
      return;
    }
    if (ask.method === 'pin') {
      await this.reply(
        chatId,
        this.fitMessage(head, '\n\nLas aprobaciones por PIN no están soportadas desde Telegram. Usa la web de Gentle Dot.'),
      );
      return;
    }

    const options = ask.options ?? [];
    if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) {
      throw new Error('malformed ask options');
    }
    if (options.length > MAX_CHOICES) {
      await this.reply(
        chatId,
        this.fitMessage(head, '\n\nDemasiadas opciones para Telegram; respóndelo en la app o web de Gentle Dot.'),
      );
      return;
    }

    const key = this.nextAskKey++;
    const pending: PendingAsk = { ask, chatId };

    if (ask.method === 'input' || ask.method === 'editor') {
      const replaced = this.awaitingInput === undefined ? undefined : this.asks.get(this.awaitingInput);
      if (this.awaitingInput !== undefined) this.forgetAsk(this.awaitingInput);
      if (replaced) {
        this.send('ui_response', { requestId: replaced.ask.requestId, cancelled: true });
      }
      if (await this.show(chatId, this.fitMessage(head, '\n\nResponde con tu respuesta, o /cancel.'))) {
        this.asks.set(key, pending);
        this.awaitingInput = key;
      }
      return;
    }

    const keyboard = new InlineKeyboard();
    if (ask.method === 'confirm') {
      keyboard.text('Permitir', `a:${key}:y`).text('Denegar', `a:${key}:n`);
    } else {
      options.forEach((option, index) => keyboard.text(option, `a:${key}:${index}`).row());
      keyboard.text('Cancelar', `a:${key}:c`);
    }

    const messageId = await this.show(chatId, this.fitMessage(head, ''), keyboard);
    if (messageId === undefined) return;
    pending.messageId = messageId;
    this.asks.set(key, pending);
  }

  private fitMessage(head: string, suffix: string): string {
    if (head.length + suffix.length <= TELEGRAM_TEXT_LIMIT) return head + suffix;
    return `${head.slice(0, TELEGRAM_TEXT_LIMIT - suffix.length - 1)}…${suffix}`;
  }

  private async show(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<number | undefined> {
    try {
      const sent = await this.bot.api.sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : {});
      return sent.message_id;
    } catch (error) {
      this.logFn(`showing a question failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async onButton(ctx: Context, key: number, choice: string): Promise<void> {
    const pending = this.asks.get(key);
    if (!pending) {
      await this.answerButton(ctx, 'Esta solicitud ya no está pendiente.');
      return;
    }
    const { requestId, options } = pending.ask;
    let payload: { type: string; requestId: string; confirmed?: boolean; cancelled?: boolean; value?: string };
    if (choice === 'y' || choice === 'n') payload = { type: 'ui_response', requestId, confirmed: choice === 'y' };
    else if (choice === 'c') payload = { type: 'ui_response', requestId, cancelled: true };
    else {
      const value = options?.[Number(choice)];
      if (value === undefined) {
        await this.answerButton(ctx, 'Esta solicitud ya no está pendiente.');
        return;
      }
      payload = { type: 'ui_response', requestId, value };
    }
    this.send(payload.type, payload);
    await this.answerButton(ctx);
    await this.removeButtons(pending);
    this.forgetAsk(key);
  }

  private async cancelInput(chatId: number): Promise<void> {
    const key = this.awaitingInput;
    const pending = key === undefined ? undefined : this.asks.get(key);
    if (key === undefined || !pending) {
      await this.reply(chatId, 'Nada que cancelar.');
      return;
    }
    this.send('ui_response', { requestId: pending.ask.requestId, cancelled: true });
    this.forgetAsk(key);
  }

  private async resolveAsk(requestId: string): Promise<void> {
    for (const [key, pending] of this.asks) {
      if (pending.ask.requestId !== requestId) continue;
      this.forgetAsk(key);
      await this.removeButtons(pending);
    }
  }

  private forgetAsk(key: number): void {
    this.asks.delete(key);
    if (this.awaitingInput === key) this.awaitingInput = undefined;
  }

  private async removeButtons(pending: PendingAsk): Promise<void> {
    if (pending.messageId === undefined) return;
    try {
      await this.bot.api.editMessageReplyMarkup(pending.chatId, pending.messageId);
    } catch (error) {
      this.logFn(`removing buttons failed: ${(error as Error).message}`);
    }
  }

  private async answerButton(ctx: Context, text?: string): Promise<void> {
    try {
      await ctx.answerCallbackQuery(text === undefined ? undefined : { text });
    } catch (error) {
      this.logFn(`answering a button failed: ${(error as Error).message}`);
    }
  }

  private async onText(chatId: number, text: string, userId: string): Promise<void> {
    if (text.trimStart().startsWith('/')) {
      await this.reply(chatId, 'Ese comando no es compatible aquí.');
      return;
    }
    const menuPrompt = MENU_ACTIONS[text];
    if (menuPrompt) {
      await this.sendToAssistant(chatId, menuPrompt);
      return;
    }
    const key = this.awaitingInput;
    const pending = key === undefined ? undefined : this.asks.get(key);
    if (key !== undefined && pending) {
      this.send('ui_response', { requestId: pending.ask.requestId, value: text });
      this.forgetAsk(key);
      return;
    }
    await this.sendToAssistant(chatId, text);
  }

  private async onVoice(chatId: number, fileId: string): Promise<void> {
    if (!this.canTranscribe) {
      await this.reply(chatId, 'La transcripción de voz no está disponible ahora; por favor escribe.');
      return;
    }
    let audio: Buffer;
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) throw new Error('no file path');
      audio = await this.downloadFn(file.file_path);
    } catch (error) {
      this.logFn(`voice download failed: ${(error as Error).message}`);
      await this.reply(chatId, 'No pude descargar esa nota de voz. Intenta de nuevo.');
      return;
    }
    const data = audio.toString('base64');
    if (data.length > MAX_VOICE_AUDIO) {
      await this.reply(chatId, 'Esa nota de voz es muy larga; mantenla bajo un minuto aprox.');
      return;
    }
    const requestId = `telegram-voice-${this.nextVoiceId++}`;
    this.send('voice_transcribe', { requestId, mime: 'audio/ogg', data });
    this.transcriptions.set(requestId, chatId);
  }

  private async onFile(chatId: number, file: IncomingFile, caption = ''): Promise<void> {
    const upload = this.uploadFn;
    if (!upload) {
      await this.reply(chatId, 'Los archivos no son compatibles aquí.');
      return;
    }
    if (this.awaitingInput !== undefined && this.asks.has(this.awaitingInput)) {
      await this.reply(chatId, 'Responde la pregunta con un mensaje de texto, o /cancel.');
      return;
    }
    if (file.size !== undefined && file.size > TELEGRAM_DOWNLOAD_LIMIT) {
      await this.reply(chatId, 'Ese archivo es muy grande: Telegram permite bots descargar hasta 20 MB.');
      return;
    }
    let data: Buffer;
    try {
      const remote = await this.bot.api.getFile(file.fileId);
      if (!remote.file_path) throw new Error('no file path');
      data = await this.downloadFn(remote.file_path);
    } catch (error) {
      this.logFn(`file download failed: ${(error as Error).message}`);
      await this.reply(chatId, 'No pude descargar ese archivo. Intenta de nuevo.');
      return;
    }
    const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    let stored: UploadedFile;
    try {
      stored = await upload({ uploadId, name: file.name, data: data.toString('base64'), size: file.size ?? data.length, mime: 'application/octet-stream' });
    } catch (error) {
      if (error instanceof Error && error.message.includes('refused')) {
        await this.reply(chatId, `⚠️ ${error.message}`);
        return;
      }
      this.logFn(`file upload failed: ${(error as Error).message}`);
      await this.reply(chatId, UNREACHABLE);
      return;
    }
    await this.sendToAssistant(chatId, caption, [{ uploadId: stored.uploadId, name: stored.name }]);
  }

  private async sendToAssistant(chatId: number, text: string, attachments?: AttachmentRef[]): Promise<void> {
    // The channel resolves its own identity (#48): the assistant always knows which channel it answers.
    const labelled = brandInbound(CHANNEL_LABEL, text);
    const payload = attachments ? { type: 'send', text: labelled, attachments } : { type: 'send', text: labelled };
    this.send(payload.type, payload);
    if (this.turn) return;
    const turn = {
      chatId,
      draftId: 1 + Math.floor(Math.random() * 2_000_000_000),
      draftText: '',
      sawBusy: BUSY_STATES.includes(this.agentState),
      refresh: setInterval(() => void this.draft(turn), DRAFT_REFRESH_MS),
    };
    this.turn = turn;
    await this.draft(turn);
  }

  private async stopChat(chatId: number): Promise<void> {
    this.send('abort', {});
    await this.reply(chatId, 'Deteniendo...');
  }

  private endTurn(): void {
    if (!this.turn) return;
    clearInterval(this.turn.refresh);
    this.turn = undefined;
  }

  private async draft(turn: typeof this.turn): Promise<void> {
    if (!turn || this.turn !== turn) return;
    try {
      await this.bot.api.sendMessageDraft(turn.chatId, turn.draftId, turn.draftText, { can_stop: true });
    } catch (error) {
      this.logFn(`draft failed: ${(error as Error).message}`);
    }
  }

  private async showMenu(chatId: number, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, { reply_markup: MENU_KEYBOARD });
    } catch (error) {
      this.logFn(`sending the menu failed: ${(error as Error).message}`);
    }
  }

  async hello(): Promise<void> {
    const chatId = this.chatId;
    if (chatId === 0) return;
    await this.showMenu(chatId, 'El puente Telegram está activo ✨\nTu menú de acciones:');
  }

  private async reply(chatId: number, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text);
    } catch (error) {
      this.logFn(`sending a message failed: ${(error as Error).message}`);
    }
  }

  async connectionLost(): Promise<void> {
    const stale = [...this.asks.values()];
    this.asks.clear();
    this.awaitingInput = undefined;
    this.transcriptions.clear();
    const turn = this.turn;
    this.endTurn();
    for (const pending of stale) await this.removeButtons(pending);
    if (!turn) return;
    await this.reply(
      turn.chatId,
      'Se perdió la conexión con Gentle Dot. Se reconectará solo; envía tu mensaje de nuevo entonces.',
    );
  }

  async setNickname(userId: string, nickname: string): Promise<void> {
    await this.nicknameStore.set(userId, nickname);
  }

  async getNickname(userId: string): Promise<string | undefined> {
    return this.nicknameStore.getByUserId(userId);
  }

  async getTelegramStatus(): Promise<{ uptime: number; users: number; memory: number }> {
    return {
      uptime: process.uptime(),
      users: await this.nicknameStore.count(),
      memory: process.memoryUsage().heapUsed,
    };
  }

  // ============ Public API ============

  async start(): Promise<void> {
    await this.nicknameStore.init();
    await this.connect();
    await this.bot.start({
      allowed_updates: ['message', 'callback_query', 'stopped_message_generation'],
      onStart: (info) => {
        this.logFn(`listening as @${info.username}`);
        this.bot.api
          .setMyCommands([
            { command: 'menu', description: 'Menú de acciones rápidas' },
            { command: 'help', description: 'Qué puede hacer este bot' },
            { command: 'stop', description: 'Detener la tarea en curso' },
            { command: 'cancel', description: 'Cancelar la respuesta pendiente' },
          ])
          .catch((error: Error) => this.logFn(`could not set the command list: ${error.message}`));
      },
    });
  }

  async stop(): Promise<void> {
    await this.onStop();
    await this.disconnect();
  }
}

// Menu actions
const MENU_ACTIONS: Record<string, string> = {
  '📊 Estado del sistema':
    'Run a quick health check of my ecosystem: the daemon, and the Telegram bridge service, then reply with a compact one-screen status report in Spanish.',
  '🗂️ Bóveda: resumen':
    'Give me a compact summary of my Obsidian vault: total notes, its main folders, and the 3 most recently modified notes. Reply briefly in Spanish.',
  '📝 Nota rápida':
    'Quick note mode: my NEXT message is the note content. When it arrives, create a note in the vault inbox folder with frontmatter (tipo: nota, fecha: today) using the first 6-8 words as the filename, then confirm briefly in Spanish.',
  '🔍 Buscar en bóveda':
    'Vault search mode: my NEXT message is a search query. Search it across the notes and reply in Spanish with the matching notes and a snippet of each match.',
  '📋 Pendientes':
    'Summarize my current pending items from our recent work together as a short checklist in Spanish.',
};

const MENU_KEYBOARD = {
  keyboard: [
    [{ text: '📊 Estado del sistema' }, { text: '🗂️ Bóveda: resumen' }],
    [{ text: '📝 Nota rápida' }, { text: '🔍 Buscar en bóveda' }],
    [{ text: '📋 Pendientes' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const HELP = [
  'Soy el puente Telegram para Gentle Dot, tu asistente personal.',
  '',
  'Escribime lo que quieras, mandame una nota de voz, un archivo, foto, video o audio; el caption va como tu mensaje.',
  '/menu vuelve a mostrar el teclado de acciones. /stop detiene la tarea en curso. /cancel cancela la respuesta pendiente.',
  'Las acciones que envían o cambian algo en tus cuentas se aprueban en la app de escritorio de Gentle Dot.',
].join('\n');
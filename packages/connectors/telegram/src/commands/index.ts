/**
 * Telegram command handlers
 */

import { Context, InlineKeyboard } from 'grammy';
import { Bridge } from '../telegram-bridge';
import { NicknameStore } from '../storage/nickname-store';

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

export const MENU_KEYBOARD = {
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

export function registerCommands(
  bot: any,
  nicknameStore: NicknameStore,
  bridge: Bridge
): void {
  // /start and /help
  bot.command(['start', 'help'], (ctx: Context) => {
    showMenu(bridge, ctx.chat!.id, HELP);
  });

  // /menu
  bot.command('menu', (ctx: Context) => {
    showMenu(bridge, ctx.chat!.id, 'Tu menú de acciones:');
  });

  // /stop
  bot.command('stop', (ctx: Context) => {
    stop(bridge, ctx.chat!.id);
  });

  // /cancel
  bot.command('cancel', (ctx: Context) => {
    cancelInput(bridge, ctx.chat!.id);
  });

  // /nickname
  bot.command('nickname', async (ctx: Context) => {
    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
      await reply(bridge, ctx.chat!.id, 'Uso: /nickname <nombre>');
      return;
    }
    const nickname = args.join(' ');
    await setNickname(bridge, nicknameStore, ctx.from!.id.toString(), nickname, ctx.chat!.id);
  });

  // Handle text messages
  bot.on('message:text', async (ctx: Context) => {
    const text = ctx.message.text;
    const chatId = ctx.chat!.id;
    const userId = ctx.from!.id.toString();

    // Check if it's a menu action
    const menuPrompt = MENU_ACTIONS[text];
    if (menuPrompt) {
      await bridge.sendToAssistant(chatId, menuPrompt);
      return;
    }

    // Check if awaiting input
    // This is handled in the bridge's onText method
    await bridge.handleText(chatId, text, userId);
  });

  // Handle callback queries
  bot.callbackQuery(/^a:(\d+):(y|n|c|\d+)$/, async (ctx: Context) => {
    const match = ctx.match;
    if (match) {
      const key = parseInt(match[1], 10);
      const choice = match[2];
      await bridge.handleCallback(key, choice);
    }
    await ctx.answerCallbackQuery();
  });
}

async function showMenu(bridge: Bridge, chatId: number, text: string): Promise<void> {
  try {
    await bridge.bot.api.sendMessage(chatId, text, { reply_markup: MENU_KEYBOARD });
  } catch (error) {
    bridge.log(`sending the menu failed: ${(error as Error).message}`);
  }
}

async function stop(bridge: Bridge, chatId: number): Promise<void> {
  if (!bridge.daemon.send({ type: 'abort' })) {
    await reply(bridge, chatId, 'Gentle Dot no está disponible ahora.');
  }
}

async function cancelInput(bridge: Bridge, chatId: number): Promise<void> {
  await bridge.cancelInput(chatId);
}

async function setNickname(
  bridge: Bridge,
  nicknameStore: NicknameStore,
  userId: string,
  nickname: string,
  chatId: number
): Promise<void> {
  try {
    await nicknameStore.set(userId, nickname);
    await reply(bridge, chatId, `✅ Apodo actualizado a: ${nickname}`);
  } catch (error) {
    await reply(bridge, chatId, `⚠️ Error: ${(error as Error).message}`);
  }
}

async function reply(bridge: Bridge, chatId: number, text: string): Promise<void> {
  try {
    await bridge.bot.api.sendMessage(chatId, text);
  } catch (error) {
    bridge.log(`sending a message failed: ${(error as Error).message}`);
  }
}
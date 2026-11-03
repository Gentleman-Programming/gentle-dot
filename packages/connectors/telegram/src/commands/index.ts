import { Bridge } from "../bridge.js";
import { NicknameStore } from "../storage/nickname-store.js";

/** Actions users can trigger from the menu; the assistant replies with a ready-made prompt. */
const MENU_ACTIONS: Record<string, string> = {
	"📊 Estado del sistema":
		"Run a quick health check of my ecosystem: the daemon, and the Telegram bridge service, then reply with a compact one-screen status report in Spanish.",
	"🗂️ Bóveda: resumen":
		"Give me a compact summary of my Obsidian vault: total notes, its main folders, and the 3 most recently modified notes. Reply briefly in Spanish.",
	"📝 Nota rápida":
		"Quick note mode: my NEXT message is the note content. When it arrives, create a note in the vault inbox folder with frontmatter (tipo: nota, fecha: today) using the first 6-8 words as the filename, then confirm briefly in Spanish.",
	"🔍 Buscar en bóveda":
		"Vault search mode: my NEXT message is a search query. Search it across the notes and reply in Spanish with the matching notes and a snippet of each match.",
	"📋 Pendientes":
		"Summarize my current pending items from our recent work together as a short checklist in Spanish.",
};

export function registerCommands(bridge: Bridge, nicknameStore: NicknameStore): void {
	bridge.bot.command("start", async (ctx) => {
		await ctx.reply("Welcome to Gentle Dot! I'm your Telegram bridge. Use /menu to see available actions.");
	});

	bridge.bot.command("help", async (ctx) => {
		await ctx.reply(
			"I'm your Gentle Dot bridge. Use /menu to see available actions, /stop to stop current task, /cancel to cancel pending input.",
		);
	});

	bridge.bot.command("menu", async (ctx) => {
		const keyboard = {
			keyboard: [
				[{ text: "📊 Estado del sistema" }, { text: "🗂️ Bóveda: resumen" }],
				[{ text: "📝 Nota rápida" }, { text: "🔍 Buscar en bóveda" }],
				[{ text: "📋 Pendientes" }],
			],
			resize_keyboard: true,
			is_persistent: true,
		};
		await ctx.reply("Tu menú de acciones:", { reply_markup: keyboard });
	});

	bridge.bot.command("stop", async (ctx) => {
		const bridgeInstance = bridge as any;
		if (bridgeInstance.stop) {
			await bridgeInstance.stop(ctx.chat!.id);
		}
	});

	bridge.bot.command("cancel", async (ctx) => {
		const bridgeInstance = bridge as any;
		if (bridgeInstance.cancelInput) {
			await bridgeInstance.cancelInput(ctx.chat!.id);
		}
	});
}
/** Turns a Markdown reply into plain text worth reading aloud: no code, links, or markup. */
export function speakableText(markdown: string): string {
	return (
		markdown
			.replace(/```[\s\S]*?(```|$)/g, " ")
			.replace(/`[^`\n]*`/g, "")
			.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/https?:\/\/\S+/g, "")
			.replace(/<[^>]+>/g, "")
			.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
			.replace(/[*_~|]/g, "")
			.replace(/^\s*-{3,}\s*$/gm, "")
			.replace(/\s+/g, " ")
			// A space left where something was removed, before punctuation.
			.replace(/\s+([.,;:!?])/g, "$1")
			.trim()
	);
}

const SPANISH = /[ñ¿¡áéíóú]|\b(que|qué|el|los|las|para|por|una|con|está|hola|gracias)\b/gi;
const ENGLISH = /\b(the|and|you|is|are|to|of|with|this|that|hello|thanks)\b/gi;

/** A best guess of the reply's language (`es` or `en`), or undefined when unclear. */
export function guessLanguage(text: string): string | undefined {
	const spanish = text.match(SPANISH)?.length ?? 0;
	const english = text.match(ENGLISH)?.length ?? 0;
	if (spanish === 0 && english === 0) return undefined;
	return spanish > english ? "es" : "en";
}

/** A system voice for the language, preferring the user's own region. */
export function pickVoice<V extends { lang: string }>(
	voices: readonly V[],
	language: string,
	preferred = "",
): V | undefined {
	const matching = voices.filter((v) => v.lang.toLowerCase().startsWith(language));
	return matching.find((v) => v.lang.toLowerCase() === preferred.toLowerCase()) ?? matching[0];
}

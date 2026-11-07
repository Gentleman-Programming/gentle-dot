import type { RecordingNoteDisplay } from "./i18n-voice-messages.ts";

/** Known renderer-owned failures retain their original Error/message contract. */
export class VoiceFailure extends Error {
	readonly display: RecordingNoteDisplay;
	constructor(message: string, display: RecordingNoteDisplay) {
		super(message);
		this.display = display;
	}
}

/** Recording-local amplitude heuristic; it does not classify speech or understand words. */
export class VoiceSilence {
	private heardActivity = false;
	private quietSince: number | undefined;
	private lastSample: number | undefined;
	private ended = false;

	private readonly kind: "daemon" | "native";

	constructor(kind: "daemon" | "native") {
		this.kind = kind;
	}

	/** True once, after activity followed by two seconds of continuously observed quiet. */
	sample(level: number, now: number): boolean {
		if (this.ended) return false;
		if (!Number.isFinite(level) || level < 0 || level > 1 || !Number.isFinite(now)) {
			this.quietSince = this.lastSample = undefined;
			return false;
		}
		// Missing meter callbacks are not silence. Both meters normally report at <=100ms.
		if (this.lastSample !== undefined && (now < this.lastSample || now - this.lastSample > 500)) {
			this.quietSince = undefined;
		}
		this.lastSample = now;
		// Browser: min(1,RMS*3). Native audio.rs: (-50dBFS..0dBFS) mapped onto 0..1.
		let rms = level / 3;
		if (this.kind === "native") rms = level > 0 ? 10 ** ((level * 50 - 50) / 20) : 0;
		if (rms >= 0.01) {
			this.heardActivity = true;
			this.quietSince = undefined;
			return false;
		}
		if (!this.heardActivity) return false;
		this.quietSince ??= now;
		if (now - this.quietSince < 2000) return false;
		this.ended = true;
		return true;
	}

	reset(): void {
		this.heardActivity = this.ended = false;
		this.quietSince = this.lastSample = undefined;
	}
}

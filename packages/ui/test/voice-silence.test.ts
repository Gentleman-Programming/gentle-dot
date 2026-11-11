import { describe, expect, it } from "vitest";
import { VoiceSilence } from "../src/voice-silence.ts";

// The same RMS0.02 activity on the linear web and logarithmic native meters.
const sources = [
	["daemon", 0.06],
	["native", (20 * Math.log10(0.02) + 50) / 50],
] as const;
function quiet(detector: VoiceSilence, start: number, end: number) {
	for (let time = start; time < end; time += 100) expect(detector.sample(0, time)).toBe(false);
}
for (const [kind, speech] of sources) {
	describe(`speech pause through ${kind}`, () => {
		it("ends once at two seconds of observed silence after activity, not before", () => {
			const detector = new VoiceSilence(kind);
			expect(detector.sample(speech, 0)).toBe(false);
			quiet(detector, 100, 2100);
			expect(detector.sample(0, 2099)).toBe(false);
			expect(detector.sample(0, 2100)).toBe(true);
			expect(detector.sample(0, 2200)).toBe(false);
		});
		it("does not stop on initial silence or continuous activity", () => {
			const detector = new VoiceSilence(kind);
			quiet(detector, 0, 5000);
			for (let time = 5000; time < 10000; time += 100) expect(detector.sample(speech, time)).toBe(false);
		});
		it("restarts the quiet interval when activity resumes", () => {
			const detector = new VoiceSilence(kind);
			detector.sample(speech, 0);
			quiet(detector, 100, 1500);
			expect(detector.sample(speech, 1500)).toBe(false);
			quiet(detector, 1600, 3600);
			expect(detector.sample(0, 3600)).toBe(true);
		});
		it("does not count a missing sample gap as silence", () => {
			const detector = new VoiceSilence(kind);
			detector.sample(speech, 0);
			detector.sample(0, 100);
			expect(detector.sample(0, 4000)).toBe(false);
			quiet(detector, 4100, 6000);
			expect(detector.sample(0, 6000)).toBe(true);
		});
		it("starts a replacement recording without the previous activity", () => {
			const detector = new VoiceSilence(kind);
			detector.sample(speech, 0);
			detector.sample(0, 100);
			detector.reset();
			quiet(detector, 200, 5000);
			detector.sample(speech, 5000);
			quiet(detector, 5100, 7100);
			expect(detector.sample(0, 7100)).toBe(true);
		});
		it("does not interpret invalid or backwards samples as quiet evidence", () => {
			const detector = new VoiceSilence(kind);
			detector.sample(speech, 0);
			quiet(detector, 100, 1500);
			expect(detector.sample(Number.NaN, 1500)).toBe(false);
			quiet(detector, 1600, 3600);
			expect(detector.sample(0, 3600)).toBe(true);
			detector.reset();
			detector.sample(speech, 5000);
			detector.sample(0, 5100);
			expect(detector.sample(0, 0)).toBe(false);
			quiet(detector, 100, 2000);
			expect(detector.sample(0, 2000)).toBe(true);
		});
	});
}

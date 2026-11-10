import { expect, it } from "vitest";
import { redactPreview } from "../src/activity-preview.ts";

it.each([65, 80])("S13.5 masks a %i-char code after an auth cue", (length) => {
	const code = "A1b2C3d4".repeat(10).slice(0, length);
	expect(redactPreview(`Your verification code is ${code}`, 2000)).not.toContain(code.slice(0, 16));
	expect(redactPreview({ subject: "Your login", body: `Your code is ${code}` }, 2000)).not.toContain(
		code.slice(0, 16),
	);
});

// Every possible cut of the scan window through a known secret, including secrets with spaces and
// punctuation and the cut right after its last character.
it.each([
	"Hunter2!Secret#Value$2024",
	"correct horse battery staple",
	"user:pa55w0rd~XYZ",
	"abc%2Fdef%3Dghijklmnop",
])("S13.5 never emits a prefix of known secret %s at the scan-window edge", (secret) => {
	const base = "word ".repeat(13107);
	for (let cut = 1; cut <= secret.length; cut++) {
		const head = base.slice(0, 65536 - cut);
		const out = redactPreview(`${head}${secret} tail`, Number.POSITIVE_INFINITY, [secret]);
		expect(out.slice(head.length - 1)).not.toContain(secret.slice(0, Math.min(4, cut)));
	}
});

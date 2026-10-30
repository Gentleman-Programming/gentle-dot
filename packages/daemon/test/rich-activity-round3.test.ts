import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { redactPreview } from "../src/activity-preview.ts";

const moduleUrl = new URL("../src/activity-preview.ts", import.meta.url).href;

// An auth cue followed by many `code=` tokens with no delimiter made every token rescan the rest
// of the text (quadratic: 64 KB took about 9 s per preview).
it.each([
	["code=", '"verification code " + "code=".repeat(13000)'],
	["code:", '"verification code " + "code:".repeat(13000)'],
	["otp=", '"your otp " + "otp=".repeat(16000)'],
	["structured", 'JSON.stringify({ subject: "Your login", body: "Your code is " + "code=".repeat(13000) })'],
])(
	"S13.5 auth-code scan stays linear: %s",
	(_name, expr) => {
		const script = `import { redactPreview } from ${JSON.stringify(moduleUrl)};
		const t = performance.now(); redactPreview(${expr}, 2000);
		if (performance.now() - t > 500) process.exit(2);`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			timeout: 5000,
		});
		expect(child.error).toBeUndefined();
		expect(child.status).toBe(0);
	},
	10000,
);

it("S13.5 still masks a real code after an auth cue", () => {
	expect(redactPreview("Your verification code is 482913", 2000)).not.toContain("482913");
	expect(redactPreview("verification code: AB12-CD34", 2000)).not.toContain("AB12-CD34");
});

// The scan window cut a known secret in two and the scanned prefix reached the wire (reasoning
// has no display cap): the cut now drops the trailing incomplete token.
it("S13.5 never emits a prefix of a known secret at the scan-window edge", () => {
	const secret = "known-secret-value-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const out = redactPreview(`${"x".repeat(65526)} ${secret} tail`, Number.POSITIVE_INFINITY, [secret]);
	expect(out).not.toContain(secret.slice(0, 8));
	expect(out.endsWith("[TRUNCATED]")).toBe(true);
});

it("S13.5 keeps ordinary order numbers in non-auth mail", () => {
	const mail = { subject: "Invoice 2024", body: "Order 123456 shipped" };
	expect(redactPreview(mail, 2000)).toBe(JSON.stringify(mail));
});

// Bounding the look-ahead must not stop masking long codes (fail closed).
it.each([65, 80])("S13.5 still masks a %i-character code after an auth cue", (length) => {
	const code = "A1b2C3d4".repeat(11).slice(0, length);
	expect(redactPreview(`Your verification code is ${code}`, 2000)).not.toContain(code.slice(0, 8));
	expect(redactPreview({ subject: "Your login", body: `Your code is ${code}` }, 2000)).not.toContain(
		code.slice(0, 8),
	);
});

// Known secrets with characters outside the token class must not leak a prefix at the edge either.
it.each([
	"Hunter2!Secret#Value$2024",
	"correct horse battery staple",
	"user:pa55w0rd~XYZ",
	"abc%2Fdef%3Dghi%26jkl",
])("S13.5 drops a known secret %s that straddles the scan-window edge", (secret) => {
	for (const offset of [1, 4, 8, secret.length - 1]) {
		const out = redactPreview(
			`${"x ".repeat(32768 - Math.ceil(offset / 2))}${secret} tail`,
			Number.POSITIVE_INFINITY,
			[secret],
		);
		for (let n = 4; n < secret.length; n++) expect(out).not.toContain(secret.slice(0, n));
	}
});

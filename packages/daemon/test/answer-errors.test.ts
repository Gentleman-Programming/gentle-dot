import { describe, expect, it } from "vitest";
import { isContentRejection } from "../src/answer-errors.ts";

const REFUSED =
	'400: {"code":"1301","message":"System detected potentially unsafe or sensitive content in input or generation. Please avoid using prompts that may generate sensitive content. Thank you for your cooperation."}';

describe("isContentRejection", () => {
	it.each([
		["the provider refusing the conversation content (code 1301)", REFUSED, true],
		[
			"the same wording from another provider, without the code",
			'400: {"message":"System detected potentially unsafe or sensitive content in input or generation."}',
			true,
		],
		["the quota", '429: {"code":"1310","message":"Weekly/Monthly quota exceeded. Reset in 2 hours."}', false],
		["a server error", "Gentle Shell provider exploded: 500 Internal Server Error", false],
		["another 400", '400: {"code":"1214","message":"Context length exceeded"}', false],
		["a sign-in problem", "401: invalid api key", false],
		["no message", undefined, false],
		["an empty message", "", false],
	] as const)("%s", (_name, message, expected) => {
		expect(isContentRejection(message)).toBe(expected);
	});
});

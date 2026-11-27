const REFUSAL_STATUS = 400;
const REFUSAL_CODE = "1301";
const REFUSAL_WORDING = /unsafe or sensitive content/i;
const STATUS_AND_CODE = new RegExp(`(^|\\D)${REFUSAL_STATUS}\\D[\\s\\S]*"code"\\s*:\\s*"${REFUSAL_CODE}"`);

/**
 * `true` when the engine error is the AI provider refusing the conversation's content itself
 * (Z.ai answers 400 with code 1301). The whole history travels with every prompt, so such a
 * refusal repeats until the conversation starts over; quota, sign-in and server errors can pass
 * on a retry.
 */
export function isContentRejection(errorMessage: string | undefined): boolean {
	if (!errorMessage) return false;
	return STATUS_AND_CODE.test(errorMessage) || REFUSAL_WORDING.test(errorMessage);
}

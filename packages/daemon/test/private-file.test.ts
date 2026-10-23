// The ownership rule `writePrivateFile` applies to the file it creates (S25.6). The check compares
// uids, so it can only run where the platform reports one; the Windows branch — no uid, no
// per-file check — is asserted here on every host instead of skipped with the privilege.
import { describe, expect, it } from "vitest";
import { assertCreatedBySelf } from "../src/private-file.ts";

describe("assertCreatedBySelf", () => {
	it("passes when the temporary file belongs to the daemon's user", () => {
		expect(() => assertCreatedBySelf("/data/.state.json.ab.tmp", 1000, 1000)).not.toThrow();
	});

	it("refuses a temporary file created as another user, naming both uids", () => {
		expect(() => assertCreatedBySelf("/data/.state.json.ab.tmp", 0, 1000)).toThrow(
			"/data/.state.json.ab.tmp was created as uid 0, not the daemon's 1000.",
		);
	});

	it("skips where the platform reports no uid, which is Windows", () => {
		expect(() => assertCreatedBySelf("C:\\data\\.state.json.ab.tmp", 0, undefined)).not.toThrow();
	});
});

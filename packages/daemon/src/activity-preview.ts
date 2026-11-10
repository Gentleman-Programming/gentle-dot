const MASK = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
/** A work budget, separate from the much smaller wire preview cap. */
const SCAN_WINDOW = 65_536;
const CODE_CHAR = /[A-Za-z0-9-]/;
const SECRET_KEY =
	/(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|session(?:[_-]?id)?|private[_-]?key)$/i;
const AUTH_MAIL =
	/\b(?:verification code|security code|one[ -]time|magic (?:link|code)|password reset|reset your password|(?:verify|confirm) your email|sign[ -]?in (?:code|link|to)|log[ -]?in (?:code|link|to)|authentication code|otp)\b/i;
const AUTH_SUBJECT =
	/\b(?:login|log[ -]in|sign[ -]?in|verification|verify|authentication|one[ -]time|otp)\b/i;
const CODE_BODY = /\b(?:code|one[ -]time|otp)\b/i;
const BODY_FIELDS = ["body", "html", "text", "content", "snippet"];
const AUTH_BODY = /^(?:body|html|text|content|snippet)$/i;
const AUTH_CODE = /^(?:(?:login|verification|security|authentication)[_-]?)?(?:code|otp)$/i;
const QUERY_CREDENTIAL = /^(?:key|sig|signature|auth|code)$/i;
const SECRET_FORMAT =
	/(?:sk-[A-Za-z0-9_-]{8}|gh[po]_[A-Za-z0-9_]|github_pat_[A-Za-z0-9_]|xox[abp]-[A-Za-z0-9-]|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35})/;
const secretKey = (key: string) => SECRET_KEY.test(key);
const space = (char: string | undefined) => char !== undefined && /\s/.test(char);

/** Every scanner consumes a maximal token once; no suffix-searching greedy regexes. */
function scanUrls(text: string, auth: boolean): string {
	const tokens = /[A-Za-z][A-Za-z0-9+.-]*/g;
	const out: string[] = [];
	let cursor = 0;
	for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
		if (text.slice(tokens.lastIndex, tokens.lastIndex + 3) !== "://") continue;
		let end = tokens.lastIndex + 3;
		while (end < text.length && !/[\s<>"'`\\]/.test(text[end] as string)) end++;
		const url = text.slice(token.index, end);
		out.push(text.slice(cursor, token.index), auth ? MASK : redactUrl(url));
		cursor = end;
		tokens.lastIndex = end;
	}
	return out.join("") + text.slice(cursor);
}

function redactUrl(url: string): string {
	const authority = url.indexOf("://") + 3;
	let end = authority;
	while (end < url.length && !"/?#".includes(url[end] as string)) end++;
	const at = url.lastIndexOf("@", end);
	const shown = at >= authority ? `${url.slice(0, authority)}${MASK}@${url.slice(at + 1)}` : url;
	// Excluding every separator from a segment prevents repeated failed scans for '='.
	return shown.replace(/([?&#])([^?&#]*)/g, (match, separator: string, segment: string) => {
		const equals = segment.indexOf("=");
		if (equals < 0) return match;
		const rawKey = segment.slice(0, equals);
		let key: string;
		try {
			key = decodeURIComponent(rawKey.replace(/\+/g, " "));
		} catch {
			return `${separator}${rawKey}=${MASK}`;
		}
		return secretKey(key) || QUERY_CREDENTIAL.test(key) ? `${separator}${rawKey}=${MASK}` : match;
	});
}

function maskPem(text: string): string {
	let cursor = 0;
	const out: string[] = [];
	for (let start = text.indexOf("-----BEGIN "); start >= 0; start = text.indexOf("-----BEGIN ", cursor)) {
		const headerEnd = text.indexOf("-----", start + 11);
		const type = headerEnd < 0 ? "" : text.slice(start + 11, Math.min(headerEnd, start + 128));
		if (!type.endsWith("PRIVATE KEY") || !/^[A-Z ]+$/.test(type)) {
			out.push(text.slice(cursor, start + 11));
			cursor = start + 11;
			continue;
		}
		const close = `-----END ${type}-----`;
		const closing = text.indexOf(close, headerEnd + 5);
		out.push(text.slice(cursor, start), MASK);
		cursor = closing < 0 ? text.length : closing + close.length;
	}
	return out.join("") + text.slice(cursor);
}

function skipSpace(text: string, start: number): number {
	let end = start;
	while (space(text[end])) end++;
	return end;
}

/** Where an unquoted shell-style value stops, as in valueEnd. */
function delimiter(char: string): boolean {
	return "\n\r,;&}\"'".includes(char) || space(char);
}

function valueEnd(text: string, start: number, shell: boolean): number {
	const quote = text[start] === '"' || text[start] === "'" ? text[start] : undefined;
	let end = start + (quote ? 1 : 0);
	while (end < text.length) {
		const char = text[end] as string;
		if (quote) {
			if (char === "\\") {
				end += 2;
				continue;
			}
			if (char === quote) return end + 1;
		} else if ("\n\r,;&}\"'".includes(char) || (shell && space(char))) break;
		end++;
	}
	return Math.min(end, text.length);
}

function maskAssignments(text: string, auth: boolean): string {
	const tokens = /[A-Za-z0-9_-]+/g;
	const mysql = /\b(?:mysql|mariadb|mysqldump)\b/i.test(text);
	const curl = /\bcurl\b/i.test(text);
	const out: string[] = [];
	let cursor = 0;
	for (let token = tokens.exec(text); token; token = tokens.exec(text)) {
		const name = token[0];
		const lower = name.toLowerCase();
		let start = tokens.lastIndex;
		let shell = false;
		let whole = false;
		let cookie = false;
		if ((mysql && name.startsWith("-p")) || (curl && name.startsWith("-u"))) {
			start = skipSpace(text, token.index + 2);
			shell = true;
		} else if (curl && name === "--user") {
			start = skipSpace(text, start);
			if (text[start] === "=") start = skipSpace(text, start + 1);
			shell = true;
		} else if (lower === "bearer" || lower === "basic") {
			if (!space(text[start])) continue;
			start = skipSpace(text, start);
			shell = true;
			whole = true;
		} else if (auth && (lower === "code" || lower === "otp")) {
			start = skipSpace(text, start);
			if (text.slice(start, start + 2).toLowerCase() === "is" && space(text[start + 2]))
				start = skipSpace(text, start + 2);
			if (text[start] === ":" || text[start] === "=") start = skipSpace(text, start + 1);
			// A code is one run of [A-Za-z0-9-] ending at a delimiter. Scanning only that run keeps
			// this linear: a run of `code=` tokens can no longer make every token rescan the rest.
			let codeEnd = start;
			while (codeEnd < text.length && CODE_CHAR.test(text[codeEnd] as string)) codeEnd++;
			if (codeEnd - start < 4 || (codeEnd < text.length && !delimiter(text[codeEnd] as string))) continue;
			shell = true;
		} else if (secretKey(name)) {
			if (text[start] === '"' || text[start] === "'") start++;
			const spaced = skipSpace(text, start);
			shell = name.startsWith("--");
			if (text[spaced] === "=" || text[spaced] === ":") {
				cookie = lower.endsWith("cookie") && text[spaced] === ":";
				start = skipSpace(text, spaced + 1);
			} else if (shell && spaced > start) start = spaced;
			else continue;
		} else continue;
		let end = valueEnd(text, start, shell);
		if (cookie) {
			end = start;
			while (end < text.length && !"\n\r".includes(text[end] as string)) end++;
		}
		if (end <= start) continue;
		const quote = !whole && !cookie && (text[start] === '"' || text[start] === "'") ? text[start] : "";
		out.push(text.slice(cursor, whole ? token.index : start), `${quote}${MASK}${quote}`);
		cursor = end;
		tokens.lastIndex = end;
	}
	return out.join("") + text.slice(cursor);
}

/** Shared bounded policy for previews and reasoning; never emits an unscanned suffix. */
export function redactPreview(value: unknown, limit: number, secrets: readonly string[] = []): string {
	const known = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
	const literal = (text: string) => {
		let shown = text;
		for (const secret of known) shown = shown.split(secret).join(MASK);
		return shown;
	};
	let remaining = SCAN_WINDOW;
	let nodes = 0;
	const ancestors = new WeakSet<object>();
	const redactText = (input: string, authContext = false): string => {
		let end = Math.min(remaining, input.length);
		remaining -= end;
		// A cut inside a secret would emit its scanned prefix: drop the trailing incomplete token,
		// then cut before any known secret that still runs past the new edge (it may hold spaces
		// or punctuation the token rule cannot see), and drop the token that cut leaves behind.
		if (end < input.length) {
			const dropToken = () => {
				while (end > 0 && /[A-Za-z0-9_.+/=-]/.test(input[end - 1] as string)) end--;
			};
			dropToken();
			for (const secret of known) {
				for (let n = Math.min(secret.length - 1, end); n > 0; n--) {
					if (input.startsWith(secret, end - n)) {
						end -= n;
						break;
					}
				}
			}
			dropToken();
		}
		const bounded = input.slice(0, end);
		const auth = authContext || AUTH_MAIL.test(bounded);
		let text = maskAssignments(scanUrls(maskPem(bounded), auth), auth);
		text = text.replace(/[A-Za-z0-9_.-]+/g, (word) => {
			if (SECRET_FORMAT.test(word)) return MASK;
			const parts = word.split(".");
			return word.startsWith("eyJ") && parts.length >= 3 && parts.every(Boolean) ? MASK : word;
		});
		if (auth) text = text.replace(/\b\d{4,10}\b/g, MASK);
		return literal(text) + (end < input.length ? TRUNCATED : "");
	};
	const visit = (input: unknown, authContext = false, depth = 0): unknown => {
		if (++nodes > 4096 || depth > 32 || remaining <= 0) return TRUNCATED;
		if (typeof input === "string") {
			if (input.length <= remaining && /^\s*[{[]/.test(input)) {
				try {
					return JSON.stringify(visit(JSON.parse(input), authContext, depth + 1));
				} catch {
					/* Plain text rather than JSON. */
				}
			}
			return redactText(input, authContext);
		}
		if (input && typeof input === "object") {
			if (ancestors.has(input)) throw new Error("cyclic preview");
			ancestors.add(input);
			let shown: unknown;
			if (Array.isArray(input)) {
				const items: unknown[] = [];
				for (const item of input) {
					if (remaining <= 0 || nodes >= 4096) {
						items.push(TRUNCATED);
						break;
					}
					items.push(visit(item, authContext, depth + 1));
				}
				shown = items;
			} else {
				const record = input as Record<string, unknown>;
				const hint = (key: string) =>
					typeof record[key] === "string" ? record[key].slice(0, remaining) : "";
				const auth =
					authContext ||
					AUTH_MAIL.test(hint("subject")) ||
					(AUTH_SUBJECT.test(hint("subject")) && BODY_FIELDS.some((key) => CODE_BODY.test(hint(key)))) ||
					BODY_FIELDS.some((key) => AUTH_MAIL.test(hint(key)));
				const entries: [string, unknown][] = [];
				for (const key in record) {
					if (!Object.hasOwn(record, key)) continue;
					if (remaining <= 0 || nodes >= 4096) {
						entries.push([TRUNCATED, TRUNCATED]);
						break;
					}
					const safeKey = redactText(key);
					entries.push([
						safeKey,
						secretKey(key) || (auth && AUTH_CODE.test(key))
							? MASK
							: visit(record[key], auth && AUTH_BODY.test(key), depth + 1),
					]);
				}
				shown = Object.fromEntries(entries);
			}
			ancestors.delete(input);
			return shown;
		}
		return input;
	};
	try {
		let input = value;
		if (typeof input === "string" && input.length <= SCAN_WINDOW) {
			try {
				input = JSON.parse(input);
			} catch {
				/* Plain text rather than JSON. */
			}
		}
		const shown = visit(input);
		const serialized = typeof shown === "string" ? shown : JSON.stringify(shown);
		// Include keys and escaped JSON in the last literal-secret scrub too.
		const safe = literal(serialized ?? "");
		return safe.slice(0, Math.max(0, limit));
	} catch {
		return MASK.slice(0, Math.max(0, limit));
	}
}

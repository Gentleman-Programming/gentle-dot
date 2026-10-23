/**
 * The daemon's claim on the folders it owns.
 *
 * The port bind only stops a second daemon on the *same* port, and the port comes from
 * `GENTLE_DOT_PORT` or `config.json` (`config.ts`), so two daemons on one data folder are reachable
 * by overriding the port. They would then share the engine's home and its setup lock, the sessions
 * folder, and the private memory server — and W5b's owner record is last-writer-wins, so a later
 * start could clear a lock a live engine still holds (odd/tasks/windows-port.md, W24).
 *
 * So a daemon claims each folder it owns before anything is written there: the folder is created
 * private if it is not there yet, and an exclusive file holding the pid of the daemon that took it
 * goes inside. A record that is not provably ours is refused rather than cleared, and the claim is
 * released on a clean stop; a claim left behind by a kill is taken over on the next start once its
 * pid is provably gone. The residual, stated rather than hidden: a pid the OS has since handed to an
 * unrelated live process reads as a live holder, and the start then refuses with the file named,
 * which one deletion clears.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isProcessAlive } from "./setup-lock.ts";

/** The daemon's claim file, in every folder a daemon owns. */
export const DAEMON_CLAIM_FILE = ".gentle-dot-daemon.lock";

/** What a claim record starts with, so a file this code did not write is never read as one. */
export const DAEMON_CLAIM_MARK = "gentle-dot-daemon";

/** How many times a losing race may retry before the claim refuses instead of spinning. */
const MAX_ATTEMPTS = 3;

/** The filesystem effects the claim reads and applies. */
export interface ClaimIo {
	exists(path: string): boolean;
	read(path: string): string;
	/** Creates the folder, and its parents, when it is not there yet; a private mode only on create. */
	ensureDir(path: string): void;
	/** Creates the file exclusively: throws `EEXIST` when it is already there. */
	create(path: string, data: string): void;
	remove(path: string): void;
}

const nodeClaimIo: ClaimIo = {
	exists: (path) => existsSync(path),
	read: (path) => readFileSync(path, "utf8"),
	ensureDir: (path) => {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	},
	create: (path, data) => writeFileSync(path, data, { flag: "wx", mode: 0o600 }),
	remove: (path) => rmSync(path, { force: true }),
};

/** What a claim attempt did, and the files it owns when it took every folder. */
export type ClaimOutcome =
	| { status: "claimed"; files: string[] }
	| { status: "already-running"; dir: string; pid: number }
	| { status: "unproven"; dir: string };

/** The folders a daemon owns: its data folder, plus the engine's home when that is set outside it. */
export function daemonClaimDirs(dataDir: string, agentHome?: string): string[] {
	const data = resolve(dataDir);
	if (!agentHome) return [data];
	const home = resolve(agentHome);
	const inside = relative(data, home);
	// An empty relative path is the folder itself; anything climbing out of it is a second folder.
	if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return [data];
	return [data, home];
}

/** The pid in a claim record of ours, or undefined when the text is not one. */
function heldPid(text: string): number | undefined {
	const match = /^gentle-dot-daemon (\d+)\n?$/.exec(text);
	if (!match?.[1]) return undefined;
	const pid = Number(match[1]);
	return pid > 0 ? pid : undefined;
}

/** One folder: take it, or say why it cannot be taken. The folder is created before the claim, so a
 * fresh data folder needs no earlier write to exist (the daemon's token used to be what made it). */
function claimOne(dir: string, io: ClaimIo, pidAlive: (pid: number) => boolean, pid: number): ClaimOutcome {
	io.ensureDir(dir);
	const file = join(dir, DAEMON_CLAIM_FILE);
	const record = `${DAEMON_CLAIM_MARK} ${pid}\n`;
	// Bounded: the winner of a race can replace the record between our read and our create, and the
	// loser has to refuse rather than spin.
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		try {
			io.create(file, record);
			return { status: "claimed", files: [file] };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let text: string;
		try {
			text = io.read(file);
		} catch {
			// An unreadable record proves nothing about its holder, so it is left alone.
			return { status: "unproven", dir };
		}
		const holder = heldPid(text);
		// An empty file is ours half written — the create and the write are two steps — and is taken
		// over. Anything else that does not read back as our record is not ours to remove.
		if (holder === undefined && text.trim() !== "") return { status: "unproven", dir };
		if (holder !== undefined && pidAlive(holder)) return { status: "already-running", dir, pid: holder };
		// A stale record, or a half-written one: remove it and try to take the folder again.
		io.remove(file);
	}
	return { status: "unproven", dir };
}

/**
 * Claims every folder, or none: a refusal releases the folders already taken, so a daemon that did
 * not start leaves nothing of its own behind.
 */
export function claimDaemonDirs(
	dirs: string[],
	io: ClaimIo = nodeClaimIo,
	pidAlive: (pid: number) => boolean = isProcessAlive,
	pid: number = process.pid,
): ClaimOutcome {
	const files: string[] = [];
	for (const dir of dirs) {
		const outcome = claimOne(dir, io, pidAlive, pid);
		if (outcome.status === "claimed") {
			files.push(...outcome.files);
			continue;
		}
		releaseDaemonClaims(files, io, pid);
		return outcome;
	}
	return { status: "claimed", files };
}

/** Releases the claims we hold, and only those: a record naming another pid is left alone. */
export function releaseDaemonClaims(
	files: string[],
	io: ClaimIo = nodeClaimIo,
	pid: number = process.pid,
): void {
	for (const file of files) {
		let text: string;
		try {
			text = io.read(file);
		} catch {
			continue; // Already gone, or unreadable: nothing that is ours to remove.
		}
		if (heldPid(text) === pid) io.remove(file);
	}
}

/** The refusal a daemon start reports, naming the pid that holds the folder or the file to remove. */
export function daemonClaimMessage(
	outcome: Extract<ClaimOutcome, { status: "already-running" | "unproven" }>,
): string {
	const file = join(outcome.dir, DAEMON_CLAIM_FILE);
	if (outcome.status === "already-running")
		return `another Gentle Dot assistant is already running on this data folder (pid ${outcome.pid} holds ${file}); stop it, or give this one a folder of its own with GENTLE_DOT_DATA_DIR`;
	return `the claim file ${file} is not a record this assistant wrote and cannot be read as a pid; refusing to start. Delete that file if no Gentle Dot assistant is running`;
}

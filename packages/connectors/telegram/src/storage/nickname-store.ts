/**
 * SQLite-backed nickname store for Telegram users (node:sqlite, no native deps).
 */
import { DatabaseSync } from "node:sqlite";
import type { NicknameEntry } from "../types.js";

export type { NicknameEntry };

export class NicknameStore {
	private readonly db: DatabaseSync;

	constructor(dbPath = ":memory:") {
		this.db = new DatabaseSync(dbPath);
		this.init();
	}

	init(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS nicknames (
				user_id TEXT PRIMARY KEY,
				nickname TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_nicknames_updated_at ON nicknames(updated_at);
		`);
	}

	set(userId: string, nickname: string): void {
		const now = Date.now();
		this.db.prepare(
			`INSERT INTO nicknames (user_id, nickname, created_at, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET
			   nickname = excluded.nickname,
			   updated_at = excluded.updated_at`,
		).run(userId, nickname, now, now);
	}

	getByUserId(userId: string): string | undefined {
		const row = this.db.prepare(
			"SELECT nickname FROM nicknames WHERE user_id = ?",
		).get(userId) as { nickname: string } | undefined;
		return row?.nickname;
	}

	getByNickname(nickname: string): string | undefined {
		const row = this.db.prepare(
			"SELECT user_id FROM nicknames WHERE nickname = ?",
		).get(nickname) as { user_id: string } | undefined;
		return row?.user_id;
	}

	delete(userId: string): boolean {
		const result = this.db.prepare("DELETE FROM nicknames WHERE user_id = ?").run(userId);
		return result.changes > 0;
	}

	count(): number {
		const row = this.db.prepare("SELECT COUNT(*) as count FROM nicknames").get() as { count: number };
		return row.count;
	}

	list(limit = 100, offset = 0): NicknameEntry[] {
		return this.db.prepare(
			"SELECT * FROM nicknames ORDER BY updated_at DESC LIMIT ? OFFSET ?",
		).all(limit, offset) as unknown as NicknameEntry[];
	}

	close(): void {
		this.db.close();
	}
}

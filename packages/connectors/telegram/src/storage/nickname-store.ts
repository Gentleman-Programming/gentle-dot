import { open } from "node:sqlite";
import { join } from "node:path";

export interface NicknameEntry {
	user_id: string;
	nickname: string;
	created_at: number;
	updated_at: number;
}

export class NicknameStore {
	private dbPromise: Promise<ReturnType<typeof open>>;

	constructor(dbPath: string = ":memory:") {
		this.dbPromise = open({
			filename: dbPath,
			driver: (await import("sqlite3")).Database,
		});
	}

	async init(): Promise<void> {
		const db = await this.dbPromise;
		await db.exec(`
			CREATE TABLE IF NOT EXISTS nicknames (
				user_id TEXT PRIMARY KEY,
				nickname TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_nicknames_updated_at ON nicknames(updated_at);
		`);
	}

	async set(userId: string, nickname: string): Promise<void> {
		const db = await this.dbPromise;
		const now = Date.now();
		await db.run(
			`
			INSERT INTO nicknames (user_id, nickname, created_at, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				nickname = excluded.nickname,
				updated_at = excluded.updated_at
			`,
			userId,
			nickname,
			now,
			now,
		);
	}

	async getByUserId(userId: string): Promise<string | undefined> {
		const db = await this.dbPromise;
		const row = await db.get("SELECT nickname FROM nicknames WHERE user_id = ?", userId);
		return row?.nickname;
	}

	async getByNickname(nickname: string): Promise<string | undefined> {
		const db = await this.dbPromise;
		const row = await db.get("SELECT user_id FROM nicknames WHERE nickname = ?", nickname);
		return row?.user_id;
	}

	async delete(userId: string): Promise<boolean> {
		const db = await this.dbPromise;
		const result = await db.run("DELETE FROM nicknames WHERE user_id = ?", userId);
		return result.changes > 0;
	}

	async count(): Promise<number> {
		const db = await this.dbPromise;
		const row = await db.get("SELECT COUNT(*) as count FROM nicknames");
		return row?.count ?? 0;
	}

	async list(limit = 100, offset = 0): Promise<NicknameEntry[]> {
		const db = await this.dbPromise;
		return db.all(
			"SELECT * FROM nicknames ORDER BY updated_at DESC LIMIT ? OFFSET ?",
			limit,
			offset,
		) as Promise<NicknameEntry[]>;
	}

	async close(): Promise<void> {
		const db = await this.dbPromise;
		await db.close();
	}
}
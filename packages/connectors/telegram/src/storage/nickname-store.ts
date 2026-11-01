/**
 * SQLite-based nickname store for Telegram users
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NicknameEntry } from '../types';

export class NicknameStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
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

  async getByUserId(userId: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT nickname FROM nicknames WHERE user_id = ?').get(userId) as
      | { nickname: string }
      | undefined;
    return row?.nickname;
  }

  async set(userId: string, nickname: string): Promise<void> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO nicknames (user_id, nickname, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        nickname = excluded.nickname,
        updated_at = excluded.updated_at
    `);
    stmt.run(userId, nickname, now, now);
  }

  async delete(userId: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM nicknames WHERE user_id = ?').run(userId);
    return result.changes > 0;
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM nicknames').get() as { count: number };
    return row.count;
  }

  async list(limit = 100, offset = 0): Promise<NicknameEntry[]> {
    const rows = this.db
      .prepare('SELECT * FROM nicknames ORDER BY updated_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as NicknameEntry[];
    return rows;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
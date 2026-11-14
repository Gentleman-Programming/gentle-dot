/**
 * Allowlist Store for WhatsApp connector
 * Manages the E.164 numbers allowed to communicate with the assistant
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export interface AllowlistEntry {
  number: string;
  addedAt: number;
  addedBy?: string;
}

const ALLOWLIST_FILE_MODE = 0o600;
const ALLOWLIST_DIR_MODE = 0o700;

export function loadAllowlistFile(filePath: string): AllowlistEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    if (!Array.isArray(data)) return [];
    return data.filter((entry): entry is AllowlistEntry =>
      typeof entry === "object" && entry !== null &&
      typeof entry.number === "string" &&
      typeof entry.addedAt === "number"
    );
  } catch {
    return [];
  }
}

export function saveAllowlistFile(filePath: string, numbers: string[]): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: ALLOWLIST_DIR_MODE });
  }
  const entries: AllowlistEntry[] = numbers.map(n => ({
    number: n,
    addedAt: Date.now(),
  }));
  writeFileSync(filePath, JSON.stringify(entries, null, 2), { mode: ALLOWLIST_FILE_MODE });
}

export function resolveAllowlist(envNumbers: string[], stored: AllowlistEntry[]): { numbers: string[]; restored: boolean } {
  const storedNumbers = new Set(stored.map(e => e.number));
  const merged = new Set([...envNumbers, ...storedNumbers]);
  return {
    numbers: Array.from(merged).sort(),
    restored: storedNumbers.size > 0,
  };
}

export function maskNumber(number: string): string {
  if (number.length <= 4) return "****";
  return "****" + number.slice(-4);
}
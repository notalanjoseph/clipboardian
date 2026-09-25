import Database from 'better-sqlite3';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface Entry {
  id: number;
  text: string;
  created_at: number;
  pinned: number;
}

const MAX_UNPINNED_ENTRIES = 500;

// How many entries the popup shows. Only limits what's displayed — stored
// history is still pruned at MAX_UNPINNED_ENTRIES, so lowering this hides
// older entries rather than deleting them.
export const DISPLAY_LIMIT_OPTIONS = [5, 10, 25, 50, 100] as const;
const DEFAULT_DISPLAY_LIMIT = 25;

let db: Database.Database;
let dbFile: string;

export function init(overridePath?: string): void {
  dbFile = overridePath ?? path.join(app.getPath('userData'), 'clipboardian.db');
  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at DESC);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function addEntry(text: string): void {
  if (!text.trim()) return;

  const existing = db
    .prepare('SELECT id FROM entries WHERE text = ? ORDER BY id DESC LIMIT 1')
    .get(text) as { id: number } | undefined;

  if (existing) {
    db.prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(Date.now(), existing.id);
  } else {
    db.prepare('INSERT INTO entries (text, created_at, pinned) VALUES (?, ?, 0)').run(
      text,
      Date.now(),
    );
    db.prepare(
      `DELETE FROM entries WHERE pinned = 0 AND id NOT IN
       (SELECT id FROM entries WHERE pinned = 0 ORDER BY created_at DESC LIMIT ?)`,
    ).run(MAX_UNPINNED_ENTRIES);
  }
}

export function getDisplayLimit(): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'displayLimit'").get() as
    | { value: string }
    | undefined;
  const n = Number(row?.value);
  return (DISPLAY_LIMIT_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_DISPLAY_LIMIT;
}

export function setDisplayLimit(n: number): void {
  if (!(DISPLAY_LIMIT_OPTIONS as readonly number[]).includes(n)) return;
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('displayLimit', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(n));
}

export function search(query: string): Entry[] {
  const q = query.trim();
  const limit = getDisplayLimit();
  if (!q) {
    return db
      .prepare('SELECT * FROM entries ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Entry[];
  }
  return db
    .prepare('SELECT * FROM entries WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?')
    .all(`%${q}%`, limit) as Entry[];
}

export function touch(id: number): void {
  db.prepare('UPDATE entries SET created_at = ? WHERE id = ?').run(Date.now(), id);
}

export function getById(id: number): Entry | undefined {
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Entry | undefined;
}

export function close(): void {
  try {
    db?.close();
  } catch {
    // best-effort
  }
}

// Deletes history but keeps settings — for Quit's "also delete clipboard
// history", where the user is keeping the app. Uninstall uses wipeData()
// instead, since a reinstall should start fully fresh. VACUUM + a WAL
// truncate so deleted text doesn't linger in free pages or the -wal file.
export function clearHistory(): void {
  db.exec('DELETE FROM entries');
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
}

export function wipeData(): void {
  close();
  const base = dbFile;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.unlinkSync(base + suffix);
    } catch {
      // ignore already-missing files
    }
  }
}

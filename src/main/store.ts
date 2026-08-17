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

export function search(query: string): Entry[] {
  const q = query.trim();
  if (!q) {
    return db
      .prepare('SELECT * FROM entries ORDER BY created_at DESC LIMIT 100')
      .all() as Entry[];
  }
  return db
    .prepare(
      'SELECT * FROM entries WHERE text LIKE ? ORDER BY created_at DESC LIMIT 100',
    )
    .all(`%${q}%`) as Entry[];
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

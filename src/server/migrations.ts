import type { DatabaseSync } from 'node:sqlite';

const migrations = [
  (db: DatabaseSync) => db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tracks (
 id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
 duration REAL NOT NULL, original TEXT NOT NULL, backing TEXT, guide TEXT, favorite INTEGER NOT NULL DEFAULT 0,
 lyrics TEXT NOT NULL DEFAULT '{"kind":"missing","lines":[],"plain":""}', lyric_offset REAL NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0, error TEXT,
 quality TEXT NOT NULL DEFAULT 'balanced', bytes INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS track_search ON tracks(title COLLATE NOCASE, artist COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS track_favorites ON tracks(favorite, created_at);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'queued', quality TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 error TEXT
);
CREATE INDEX IF NOT EXISTS job_queue ON jobs(status, created_at);
CREATE TABLE IF NOT EXISTS queue (
 id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE, singer TEXT NOT NULL, position INTEGER NOT NULL
);
`),
  (db: DatabaseSync) => {
    const columns = (db.prepare('PRAGMA table_info(tracks)').all() as { name: string }[]).map(column => column.name);
    for (const name of ['model', 'generation']) if (!columns.includes(name)) db.exec(`ALTER TABLE tracks ADD COLUMN ${name} TEXT`);
    db.exec(`CREATE TABLE IF NOT EXISTS alignment_jobs (
 id TEXT PRIMARY KEY, track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'queued', progress REAL NOT NULL DEFAULT 0, error TEXT,
 lyrics_snapshot TEXT NOT NULL, guide_snapshot TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS alignment_active ON alignment_jobs(track_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS alignment_queue ON alignment_jobs(status, created_at);
`);
  },
];
export function migrate(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > migrations.length) throw new Error('Database schema is newer than this app.');
    for (let i = version; i < migrations.length; i++) { migrations[i](db); db.exec(`PRAGMA user_version=${i + 1}`); }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

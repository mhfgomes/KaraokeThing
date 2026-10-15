import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations';
import { mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Track, Lyrics, QueueEntry } from '../lib/types';

// Without KARAOKE_DATA_DIR, scripts run from apps/web and share the repository's data folder.
export const DATA_DIR = path.resolve(/* turbopackIgnore: true */ process.env.KARAOKE_DATA_DIR || '../../data');
for (const dir of ['', 'tracks', 'temporary', 'models', 'lyrics']) mkdirSync(path.join(/* turbopackIgnore: true */ DATA_DIR, dir), { recursive: true });
const globalDb = globalThis as typeof globalThis & { karaokeDb?: DatabaseSync };
export const db = globalDb.karaokeDb ??= new DatabaseSync(path.join(DATA_DIR, 'library.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
migrate(db);

export function setting(key: string): string | null {
  return (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null;
}
export function setSetting(key: string, value: string) {
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
export function transaction<T>(work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export interface TrackRow {
  id: string; hash: string; title: string; artist: string; album: string; duration: number;
  original: string; backing: string | null; guide: string | null; favorite: number;
  lyrics: string; lyric_offset: number; status: Track['status']; progress: number;
  error: string | null; quality: Track['quality']; bytes: number; created_at: string;
  model: string | null; generation: string | null;
}
export const missingLyrics: Lyrics = { kind: 'missing', lines: [], plain: '' };
export function getTrack(id: string): TrackRow | undefined {
  return db.prepare('SELECT * FROM tracks WHERE id=?').get(id) as unknown as TrackRow | undefined;
}
export function publicTrack(row: TrackRow): Track {
  let lyrics = missingLyrics;
  try { lyrics = JSON.parse(row.lyrics) as Lyrics; } catch { /* retain missing state for corrupt data */ }
  const alignment = db.prepare('SELECT status,progress,error FROM alignment_jobs WHERE track_id=? ORDER BY rowid DESC LIMIT 1').get(row.id) as Track['alignment'];
  return { id: row.id, title: row.title, artist: row.artist, album: row.album, duration: row.duration,
    favorite: !!row.favorite, status: row.status, progress: row.progress, error: row.error,
    quality: row.quality, lyrics, lyricOffset: row.lyric_offset, bytes: row.bytes, createdAt: row.created_at, ...(alignment ? { alignment } : {}) };
}
export function getQueue(): QueueEntry[] {
  return (db.prepare('SELECT id,track_id,singer,position FROM queue ORDER BY position').all() as { id: string; track_id: string; singer: string; position: number }[])
    .map(r => ({ id: r.id, trackId: r.track_id, singer: r.singer, position: r.position }));
}
export function managedPath(relative: string): string {
  const candidate = path.resolve(DATA_DIR, relative);
  if (!candidate.startsWith(DATA_DIR + path.sep)) throw new Error('Invalid managed asset path');
  return candidate;
}
export async function existingManagedPath(relative: string): Promise<string> {
  const [root, candidate] = await Promise.all([realpath(DATA_DIR), realpath(managedPath(relative))]);
  if (!candidate.startsWith(root + path.sep)) throw new Error('Managed asset resolves outside the data directory.');
  return candidate;
}

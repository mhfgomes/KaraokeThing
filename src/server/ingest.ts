import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { DATA_DIR, db, transaction } from './db';
import { HttpError } from './auth';

export const FORMATS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg']);
export const MAX_FILE_BYTES = 250 * 1024 * 1024;
export function importRoots(): string[] {
  return (process.env.KARAOKE_IMPORT_ROOTS || '').split(path.delimiter).filter(Boolean).map(p => path.resolve(p));
}
export async function fileHash(filename: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function ingestFile(filename: string, displayName: string, quality: 'balanced' | 'high' = 'balanced'): Promise<'added' | 'duplicate'> {
  const ext = path.extname(displayName).toLowerCase();
  if (!FORMATS.has(ext)) throw new HttpError(400, `Unsupported file: ${displayName}. Use MP3, WAV, FLAC, M4A, or OGG.`);
  const info = await stat(filename);
  if (!info.isFile() || info.size > MAX_FILE_BYTES || info.size === 0) throw new HttpError(400, `${displayName}: file must be nonempty and under 250 MB.`);
  const hash = await fileHash(filename);
  if (db.prepare('SELECT id FROM tracks WHERE hash=?').get(hash)) return 'duplicate';
  const metadata = await parseFile(filename, { duration: true, skipCovers: true });
  const duration = metadata.format.duration;
  if (!duration || !Number.isFinite(duration) || duration <= 0 || duration > 1800) throw new HttpError(400, `${displayName}: cannot read audio duration, or it exceeds 30 minutes.`);
  const id = randomUUID();
  const dir = path.join(DATA_DIR, 'tracks', id);
  await mkdir(dir, { recursive: true });
  const original = path.join('tracks', id, `original${ext}`);
  try {
    await copyFile(filename, path.join(DATA_DIR, original));
    const now = new Date().toISOString();
    return transaction(() => {
      if (db.prepare('SELECT id FROM tracks WHERE hash=?').get(hash)) return 'duplicate';
      db.prepare(`INSERT INTO tracks(id,hash,title,artist,album,duration,original,quality,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        id, hash, (metadata.common.title || path.basename(displayName, path.extname(displayName))).slice(0, 300),
        (metadata.common.artist || 'Unknown artist').slice(0, 300), (metadata.common.album || '').slice(0, 300), duration, original, quality, info.size, now);
      db.prepare('INSERT INTO jobs(id,track_id,quality,created_at,updated_at) VALUES (?,?,?,?,?)').run(randomUUID(), id, quality, now, now);
      return 'added';
    });
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  finally {
    if (!db.prepare('SELECT id FROM tracks WHERE id=?').get(id)) await rm(dir, { recursive: true, force: true });
  }
}
export async function importFolder(candidate: string, quality: 'balanced' | 'high') {
  const target = await realpath(candidate);
  const roots = await Promise.all(importRoots().map(async p => realpath(p).catch(() => '')));
  if (!roots.some(root => root && (target === root || target.startsWith(root + path.sep)))) throw new HttpError(403, 'This folder is not in KARAOKE_IMPORT_ROOTS. Configure an allowed folder on the host first.');
  if (!(await stat(target)).isDirectory()) throw new HttpError(400, 'Choose a folder to import.');
  const result = { added: 0, duplicates: 0, errors: [] as string[] };
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && FORMATS.has(path.extname(entry.name).toLowerCase())) {
        try { const outcome = await ingestFile(file, entry.name, quality); if (outcome === 'added') result.added++; else result.duplicates++; }
        catch (error) { result.errors.push(`${entry.name}: ${error instanceof Error ? error.message : 'Import failed'}`); }
      }
    }
  }
  await walk(target);
  return result;
}

import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, renameSync } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { z } from 'zod';
import { DATA_DIR, db, getTrack, publicTrack, getQueue, setting, setSetting, transaction, existingManagedPath, type TrackRow } from './db';
import { HttpError, requireAdmin, requireSameOrigin, isAdmin, passwordHash, passwordMatches, createSession, sessionCookie, cookieToken, sessionHash, checkLoginAttempts, recordFailedLogin, clearLoginAttempts, setupRequired } from './auth';
import { ingestFile, importFolder, importRoots, MAX_FILE_BYTES } from './ingest';
import { lookupLyrics, searchLyrics, selectLyrics } from './lyrics';
import { queueAlignment, cancelAlignment, wordAlignmentEnabled } from './alignment-jobs';

const qualitySchema = z.enum(['balanced', 'high']).default('balanced');
const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
async function body(request: Request) {
  const text = await request.text();
  if (text.length > 64000) throw new HttpError(413, 'Request is too large.');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON request.'); }
}
function activeSession() {
  const encoded = setting('active_session');
  if (!encoded) return null;
  try {
    const active = JSON.parse(encoded) as { trackId: string; controller: string; expiresAt: number; owner: string };
    const session = active?.owner && db.prepare('SELECT expires FROM sessions WHERE hash=?').get(active.owner) as { expires: number } | undefined;
    return active?.expiresAt > Date.now() && session && session.expires > Date.now() ? active : null;
  } catch { return null; }
}
export async function saveLyrics(id: string, lyrics: Awaited<ReturnType<typeof lookupLyrics>>, alignmentJob?: { id: string; lyrics_snapshot: string; guide_snapshot: string }, onlyMissing = false) {
  const dest = path.join(DATA_DIR, 'lyrics', `${id}.json`);
  const temporary = `${dest}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(lyrics));
    const saved = transaction(() => {
      const track = getTrack(id);
      if (!track) throw new HttpError(404, 'Song no longer exists.');
      if (onlyMissing && JSON.parse(track.lyrics).kind !== 'missing') return false;
      if (alignmentJob && (track.lyrics !== alignmentJob.lyrics_snapshot || track.guide !== alignmentJob.guide_snapshot || (db.prepare('SELECT status FROM alignment_jobs WHERE id=?').get(alignmentJob.id) as { status: string } | undefined)?.status !== 'running')) throw new HttpError(409, 'Lyrics or audio changed during word alignment.');
      renameSync(temporary, dest);
      db.prepare('UPDATE tracks SET lyrics=? WHERE id=?').run(JSON.stringify(lyrics), id);
      if (alignmentJob) db.prepare("UPDATE alignment_jobs SET status='completed',progress=1,error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), alignmentJob.id);
      return true;
    });
    if (saved && !alignmentJob && getTrack(id)?.guide) {
      cancelAlignment(id);
      queueAlignment(id);
    }
  } finally { await rm(temporary, { force: true }); }
}
async function upload(request: Request) {
  if (!request.body) throw new HttpError(400, 'No files were uploaded.');
  const result = { added: 0, duplicates: 0, errors: [] as string[] };
  const pending: Promise<void>[] = [];
  let ingestion = Promise.resolve();
  let quality: 'balanced' | 'high' = 'balanced';
  const parser = Busboy({ headers: { 'content-type': request.headers.get('content-type') || '' }, limits: { fileSize: MAX_FILE_BYTES, files: 100, fields: 5, fieldSize: 1000 } });
  parser.on('field', (name, value) => { if (name === 'quality') quality = qualitySchema.parse(value); });
  parser.on('filesLimit', () => result.errors.push('Upload at most 100 files per batch.'));
  parser.on('file', (_name, file, info) => {
    const originalName = info.filename ?? 'unnamed file';
    const filename = path.join(DATA_DIR, 'temporary', randomUUID() + path.extname(originalName).toLowerCase());
    pending.push((async () => {
      try {
        await pipeline(file, createWriteStream(filename), { signal: request.signal });
        if (file.truncated) throw new HttpError(413, `${originalName} exceeds 250 MB.`);
        const task = ingestion.then(() => ingestFile(filename, path.basename(originalName), quality, request.signal));
        ingestion = task.then(() => {}, () => {});
        const outcome = await task;
        if (outcome === 'added') result.added++; else result.duplicates++;
      } catch (error) { result.errors.push(error instanceof Error ? error.message : 'Upload failed.'); }
      finally { await rm(filename, { force: true }); }
    })());
  });
  try { await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), parser, { signal: request.signal }); }
  finally { await Promise.all(pending); }
  return json(result);
}
async function media(request: Request, id: string, asset: string) {
  const track = getTrack(id);
  if (!track) throw new HttpError(404, 'Song not found.');
  if (asset !== 'backing' && asset !== 'guide' && asset !== 'original') throw new HttpError(404, 'Audio asset not found.');
  if (asset === 'original') requireAdmin(request);
  const relative = track[asset];
  if (!relative) throw new HttpError(404, 'This song has not finished preparation.');
  const file = await existingManagedPath(relative);
  const size = (await stat(file)).size;
  const mime = asset !== 'original' || file.endsWith('.mp3') ? 'audio/mpeg' : file.endsWith('.wav') ? 'audio/wav' : file.endsWith('.flac') ? 'audio/flac' : file.endsWith('.m4a') ? 'audio/mp4' : 'audio/ogg';
  const headers: Record<string, string> = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  let start = 0, end = size - 1, statusCode = 200;
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (start > end || start >= size || start < 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    statusCode = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  if (request.method === 'HEAD') return new Response(null, { status: statusCode, headers });
  const stream = createReadStream(file, { start, end });
  request.signal.addEventListener('abort', () => stream.destroy(), { once: true });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: statusCode, headers });
}

export async function handleApi(request: Request, segments: string[]): Promise<Response> {
  try {
    const route = segments.join('/');
    const method = request.method;
    const methods = route === 'state' ? ['GET'] : ['auth', 'upload', 'import', 'session'].includes(route) ? ['POST'] : route === 'queue' ? ['POST', 'PATCH', 'DELETE'] : segments[0] === 'media' && segments.length === 3 ? ['GET', 'HEAD'] : segments[0] === 'tracks' && segments.length === 2 ? ['GET', 'PATCH', 'DELETE'] : segments[0] === 'tracks' && segments.length === 3 ? segments[2] === 'lyrics' ? ['GET', 'POST'] : ['prepare', 'alignment'].includes(segments[2]) ? ['POST'] : null : null;
    if (methods && !methods.includes(method)) return json({ error: 'Method not allowed.' }, 405, { Allow: methods.join(', ') });
    if (!['GET', 'HEAD'].includes(method)) requireSameOrigin(request);
    if (route === 'state' && method === 'GET') {
      const url = new URL(request.url);
      const q = (url.searchParams.get('q') || '').slice(0, 300);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const filter = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      const favorites = url.searchParams.get('favorites') === '1';
      const where = `WHERE (title LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\') ${favorites ? 'AND favorite=1' : ''}`;
      const tracks = (db.prepare(`SELECT * FROM tracks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(filter, filter, limit, (page - 1) * limit) as unknown as TrackRow[]).map(publicTrack);
      const total = (db.prepare(`SELECT COUNT(*) as count FROM tracks ${where}`).get(filter, filter) as { count: number }).count;
      const storageBytes = (db.prepare('SELECT COALESCE(SUM(bytes),0) as size FROM tracks').get() as { size: number }).size;
      let worker = { updated: 0, processing: false, modelReady: false, modelError: 'Start the app with pnpm dev or pnpm start to run the preparation worker.' as string | null };
      try { worker = { ...worker, ...JSON.parse(setting('worker') || '{}') }; } catch { /* offline state */ }
      const active = activeSession();
      return json({ admin: isAdmin(request), setupRequired: setupRequired(), wordAlignmentEnabled: wordAlignmentEnabled(), tracks, total, queue: getQueue(), active: active ? { trackId: active.trackId, controller: active.controller, expiresAt: active.expiresAt } : null, storageBytes,
        importRoots: isAdmin(request) ? importRoots() : [], worker: { online: worker.updated > Date.now() - 20000, processing: worker.processing, modelReady: worker.modelReady, modelError: worker.modelError } });
    }
    if (segments[0] === 'media' && segments.length === 3 && ['GET', 'HEAD'].includes(method)) return await media(request, segments[1], segments[2]);
    if (segments[0] === 'tracks' && segments.length === 2 && method === 'GET') {
      const track = getTrack(segments[1]);
      if (!track) throw new HttpError(404, 'Song not found.');
      return json({ track: publicTrack(track) });
    }
    if (route === 'auth' && method === 'POST') {
      const input = z.object({ action: z.enum(['setup', 'login', 'logout', 'password']), password: z.string().max(1024).default(''), newPassword: z.string().max(1024).optional() }).parse(await body(request));
      if (input.action === 'logout') {
        if (activeSession()?.owner === sessionHash(cookieToken(request))) setSetting('active_session', 'null');
        db.prepare('DELETE FROM sessions WHERE hash=?').run(sessionHash(cookieToken(request)));
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
      }
      if (input.action === 'setup') {
        if (input.password.length < 8) throw new HttpError(400, 'Use an admin password with at least eight characters.');
        const encoded = passwordHash(input.password);
        transaction(() => { if (!setupRequired()) throw new HttpError(409, 'An admin password is already set. Sign in instead.'); setSetting('password', encoded); });
        return json({ ok: true }, 200, { 'Set-Cookie': createSession(request) });
      }
      checkLoginAttempts(request);
      const hash = setting('password');
      if (!hash || !passwordMatches(input.password, hash)) { recordFailedLogin(request); throw new HttpError(401, 'Incorrect host password.'); }
      clearLoginAttempts(request);
      if (input.action === 'password') {
        requireAdmin(request);
        if (!input.newPassword || input.newPassword.length < 8) throw new HttpError(400, 'Use at least eight characters for the new password.');
        transaction(() => { setSetting('password', passwordHash(input.newPassword!)); db.exec('DELETE FROM sessions'); setSetting('active_session', 'null'); });
      }
      return json({ ok: true }, 200, { 'Set-Cookie': createSession(request) });
    }
    requireAdmin(request);
    if (route === 'upload' && method === 'POST') return await upload(request);
    if (route === 'import' && method === 'POST') {
      const input = z.object({ path: z.string().min(1).max(4096), quality: qualitySchema }).parse(await body(request));
      return json(await importFolder(input.path, input.quality));
    }
    if (segments[0] === 'tracks' && segments[1]) {
      const id = segments[1];
      const track = getTrack(id);
      if (!track) throw new HttpError(404, 'Song not found.');
      if (segments.length === 2 && method === 'PATCH') {
        const input = z.object({ title: z.string().min(1).max(300).optional(), artist: z.string().min(1).max(300).optional(), album: z.string().max(300).optional(), favorite: z.boolean().optional(), lyricOffset: z.number().min(-30).max(30).optional() }).strict().parse(await body(request));
        db.prepare('UPDATE tracks SET title=?,artist=?,album=?,favorite=?,lyric_offset=? WHERE id=?').run(input.title ?? track.title, input.artist ?? track.artist, input.album ?? track.album, input.favorite === undefined ? track.favorite : Number(input.favorite), input.lyricOffset ?? track.lyric_offset, id);
        return json({ ok: true });
      }
      if (segments.length === 2 && method === 'DELETE') {
        if (activeSession()?.trackId === id) throw new HttpError(409, 'Stop this song before deleting it.');
        transaction(() => { db.prepare("UPDATE jobs SET status='canceled' WHERE track_id=? AND status IN ('queued','running')").run(id); db.prepare('DELETE FROM tracks WHERE id=?').run(id); });
        await rm(path.join(DATA_DIR, 'tracks', id), { recursive: true, force: true });
        await rm(path.join(DATA_DIR, 'lyrics', `${id}.json`), { force: true });
        return json({ ok: true });
      }
      if (segments[2] === 'prepare' && method === 'POST') {
        const input = z.object({ action: z.enum(['retry', 'cancel']), quality: qualitySchema.optional() }).parse(await body(request));
        const quality = input.quality ?? track.quality;
        const now = new Date().toISOString();
        transaction(() => {
          db.prepare("UPDATE jobs SET status='canceled',updated_at=? WHERE track_id=? AND status IN ('running','queued')").run(now, id);
          if (input.action === 'retry') {
            db.prepare('INSERT INTO jobs(id,track_id,quality,created_at,updated_at) VALUES (?,?,?,?,?)').run(randomUUID(), id, quality, now, now);
            db.prepare("UPDATE tracks SET status='queued',quality=?,progress=0,error=NULL WHERE id=?").run(quality, id);
          } else db.prepare("UPDATE tracks SET status=?,error=NULL WHERE id=?").run(track.backing && track.guide ? 'ready' : 'canceled', id);
        });
        return json({ ok: true });
      }
      if (segments[2] === 'lyrics') {
        if (method === 'GET') return json({ matches: await searchLyrics(track.title, track.artist) });
        if (method === 'POST') {
          const input = z.union([z.object({ matchId: z.number().int().nonnegative() }), z.object({ action: z.literal('lookup') })]).parse(await body(request));
          const lyrics = 'matchId' in input ? await selectLyrics(input.matchId) : await lookupLyrics(track);
          await saveLyrics(id, lyrics);
          return json({ lyrics });
        }
      }
      if (segments[2] === 'alignment' && method === 'POST') {
        const input = z.object({ action: z.enum(['start', 'cancel']) }).parse(await body(request));
        if (input.action === 'cancel') cancelAlignment(id);
        else queueAlignment(id, true);
        return json({ ok: true });
      }
    }
    if (route === 'queue') {
      const input = await body(request);
      if (method === 'POST') {
        const item = z.object({ trackId: z.string(), singer: z.string().trim().min(1).max(100) }).parse(input);
        const track = getTrack(item.trackId);
        if (!track || track.status !== 'ready') throw new HttpError(400, 'Prepare this song before adding it to the queue.');
        transaction(() => {
          const max = (db.prepare('SELECT COALESCE(MAX(position),-1) as position FROM queue').get() as { position: number }).position;
          db.prepare('INSERT INTO queue VALUES (?,?,?,?)').run(randomUUID(), item.trackId, item.singer, max + 1);
        });
      } else if (method === 'PATCH') {
        const { ids } = z.object({ ids: z.array(z.string()).max(1000) }).parse(input);
        transaction(() => {
          const existing = getQueue().map(item => item.id);
          if (new Set(ids).size !== ids.length || ids.length !== existing.length || ids.some(id => !existing.includes(id))) throw new HttpError(409, 'The queue changed. Refresh it before reordering.');
          ids.forEach((id, i) => db.prepare('UPDATE queue SET position=? WHERE id=?').run(i, id));
        });
      } else if (method === 'DELETE') db.prepare('DELETE FROM queue WHERE id=?').run(z.object({ id: z.string() }).parse(input).id);
      else throw new HttpError(405, 'Method not allowed.');
      return json({ ok: true });
    }
    if (route === 'session' && method === 'POST') {
      const input = z.object({ action: z.enum(['claim', 'heartbeat', 'release']), controller: z.string().min(8).max(100), trackId: z.string().optional() }).parse(await body(request));
      transaction(() => {
        const current = activeSession();
        const owner = sessionHash(cookieToken(request));
        if (current && (current.controller !== input.controller || current.owner !== owner)) throw new HttpError(409, 'Another browser controls the active song. Stop it there or wait for its session to expire.');
        if (input.action === 'release') { setSetting('active_session', 'null'); return; }
        if (input.action === 'claim') {
          if (!input.trackId || getTrack(input.trackId)?.status !== 'ready') throw new HttpError(400, 'Choose a prepared song.');
          setSetting('active_session', JSON.stringify({ trackId: input.trackId, controller: input.controller, expiresAt: Date.now() + 30000, owner }));
        } else {
          if (!current) throw new HttpError(409, 'Playback session expired. Start the song again.');
          setSetting('active_session', JSON.stringify({ ...current, expiresAt: Date.now() + 30000 }));
        }
      });
      return json({ ok: true });
    }
    throw new HttpError(404, 'API route not found.');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    console.error('[api]', error);
    return json({ error: error instanceof Error ? error.message : 'Unexpected server error.' }, 500);
  }
}

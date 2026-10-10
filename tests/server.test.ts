import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const temp = await mkdtemp(path.join(os.tmpdir(), 'karaoke-server-test-'));
process.env.KARAOKE_DATA_DIR = temp;
const { handleApi, saveLyrics } = await import('../src/server/api');
const { db, setting, managedPath, getTrack, transaction, existingManagedPath } = await import('../src/server/db');
const { parseLrc, normalizeLyrics } = await import('../src/server/lyrics');
let cookie = '';
async function call(route: string, method = 'GET', data?: unknown, admin = true, origin = 'http://localhost:3000') {
  return handleApi(new Request(`http://localhost:3000/api/${route}`, { method, headers: { host: 'localhost:3000', origin, ...(admin && cookie ? { cookie } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), route.split('?')[0].split('/'));
}
async function seed(title = 'A song') {
  const id = randomUUID();
  await mkdir(path.join(temp, 'tracks', id), { recursive: true });
  for (const file of ['original.mp3', 'backing.mp3', 'guide.mp3']) await writeFile(path.join(temp, 'tracks', id, file), Buffer.alloc(1024, 42));
  db.prepare(`INSERT INTO tracks(id,hash,title,artist,album,duration,original,backing,guide,status,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, randomUUID(), title, 'An artist', '', 120, `tracks/${id}/original.mp3`, `tracks/${id}/backing.mp3`, `tracks/${id}/guide.mp3`, 'ready', 3072, new Date().toISOString());
  return id;
}
after(async () => { db.close(); await rm(temp, { recursive: true, force: true }); });

test('setup, hashed password, read-only visitors, and cross-origin rejection', async () => {
  let response = await call('auth', 'POST', { action: 'setup', password: 'test-password-unique' });
  assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  assert.ok(response.headers.get('set-cookie')!.includes('HttpOnly'));
  assert.ok(!setting('password')!.includes('test-password-unique'));
  response = await call('auth', 'POST', { action: 'setup', password: 'another-password' });
  assert.equal(response.status, 409);
  const state = await (await call('state', 'GET', undefined, false)).json();
  assert.equal(state.admin, false); assert.equal(state.setupRequired, false);
  assert.equal((await call('queue', 'POST', { trackId: 'x', singer: 'Guest' }, false)).status, 401);
  assert.equal((await call('queue', 'POST', { trackId: 'x', singer: 'Guest' }, true, 'https://attacker.example')).status, 403);
  assert.equal((await call('auth', 'POST', { action: 'login', password: 'bad' })).status, 401);
});
test('multipart uploads without a filename return an unsupported-file error without crashing', async () => {
  const boundary = 'karaoke-unnamed-upload';
  const request = new Request('http://localhost:3000/api/upload', {
    method: 'POST',
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: `--${boundary}\r\nContent-Disposition: form-data; name="files"\r\nContent-Type: application/octet-stream\r\n\r\naudio bytes\r\n--${boundary}--\r\n`,
  });
  const response = await handleApi(request, ['upload']);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.added, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Unsupported file: unnamed file/);
});
test('queue reorder validates exact membership and conflicts without partial mutation', async () => {
  const first = await seed('First'), second = await seed('Second');
  assert.equal((await call('queue', 'POST', { trackId: first, singer: 'Mario' })).status, 200);
  assert.equal((await call('queue', 'POST', { trackId: second, singer: 'Friends' })).status, 200);
  const initial = (await (await call('state')).json()).queue;
  assert.equal((await call('queue', 'PATCH', { ids: [initial[0].id, initial[0].id] })).status, 409);
  assert.deepEqual((await (await call('state')).json()).queue.map((e: { id: string }) => e.id), initial.map((e: { id: string }) => e.id));
  assert.equal((await call('queue', 'PATCH', { ids: [initial[1].id, initial[0].id] })).status, 200);
  assert.equal((await (await call('state')).json()).queue[0].trackId, second);
});
test('playback control lease refuses a second browser and protects active deletion', async () => {
  const id = await seed('Lease song');
  assert.equal((await call('session', 'POST', { action: 'claim', controller: 'browser-one', trackId: id })).status, 200);
  assert.equal((await call('session', 'POST', { action: 'claim', controller: 'browser-two', trackId: id })).status, 409);
  assert.equal((await call(`tracks/${id}`, 'DELETE')).status, 409);
  assert.equal((await call('session', 'POST', { action: 'heartbeat', controller: 'browser-one' })).status, 200);
  assert.equal((await call('session', 'POST', { action: 'release', controller: 'browser-one' })).status, 200);
  assert.equal((await call(`tracks/${id}`, 'DELETE')).status, 200);
  assert.equal(getTrack(id), undefined);
});
test('media byte ranges and original-file permissions', async () => {
  const id = await seed('Media');
  const request = new Request(`http://localhost:3000/api/media/${id}/backing`, { headers: { range: 'bytes=100-199' } });
  const response = await handleApi(request, ['media', id, 'backing']);
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 100-199/1024');
  assert.equal((await response.arrayBuffer()).byteLength, 100);
  assert.equal((await call(`media/${id}/original`, 'GET', undefined, false)).status, 401);
  assert.equal((await handleApi(new Request(`http://localhost:3000/api/media/${id}/backing`, { headers: { range: 'bytes=2000-' } }), ['media', id, 'backing'])).status, 416);
});
test('search escapes wildcard characters, favorites persist, paths cannot escape', async () => {
  const id = await seed('100% song');
  await call(`tracks/${id}`, 'PATCH', { favorite: true });
  const response = await call('state?q=100%25&favorites=1');
  const state = await response.json();
  assert.equal(state.total, 1); assert.equal(state.tracks[0].id, id); assert.equal(state.tracks[0].favorite, true);
  assert.throws(() => managedPath('../outside'));
});
test('retry/cancel creates durable jobs and preserves previous prepared assets', async () => {
  const id = await seed('Retry');
  assert.equal((await call(`tracks/${id}/prepare`, 'POST', { action: 'retry', quality: 'high' })).status, 200);
  assert.equal(getTrack(id)!.status, 'queued');
  assert.equal((await call(`tracks/${id}/prepare`, 'POST', { action: 'cancel' })).status, 200);
  assert.equal(getTrack(id)!.status, 'ready');
  assert.equal((db.prepare('SELECT status FROM jobs WHERE track_id=?').get(id) as { status: string }).status, 'canceled');
});
test('line and enhanced word lyrics retain real timings and honest fallbacks', () => {
  const lines = parseLrc('[offset:100]\n[00:01.50][00:05.00]Hello\n[00:08.00]<00:08.00>Sing <00:08.50>now');
  assert.equal(lines[0].start, 1.6); assert.equal(lines[1].start, 5.1);
  assert.equal(lines[2].words![1].start, 8.6);
  const base = { id: 1, trackName: 'Song', artistName: 'Artist', albumName: '', duration: 1 };
  assert.equal(normalizeLyrics({ ...base, plainLyrics: 'Hello' }).kind, 'plain');
  assert.equal(normalizeLyrics(base).kind, 'missing');
  assert.equal(normalizeLyrics({ ...base, syncedLyrics: '[00:01.00]Hello' }).kind, 'line');
  const words = normalizeLyrics({ ...base, lyricsfile: { lines: [{ start_ms: 1000, words: [{ text: 'Hello', start_ms: 1000, end_ms: 1200 }] }] } });
  assert.equal(words.kind, 'word'); assert.equal(words.lines[0].words![0].end, 1.2);
});
test('logout invalidates playback lease; stale cookies cannot heartbeat', async () => {
  const id = await seed('Revoked lease');
  await call('session', 'POST', { action: 'claim', controller: 'browser-revoked', trackId: id });
  assert.equal((await call('auth', 'POST', { action: 'logout' })).status, 200);
  assert.equal((await (await call('state')).json()).active, null);
  assert.equal((await call('session', 'POST', { action: 'heartbeat', controller: 'browser-revoked' })).status, 401);
  const login = await call('auth', 'POST', { action: 'login', password: 'test-password-unique' });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
});
test('managed symlink cannot expose an outside asset', async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'karaoke-outside-'));
  try {
    await writeFile(path.join(outside, 'private.mp3'), 'outside');
    await symlink(outside, path.join(temp, 'tracks', 'link'), 'dir');
    await assert.rejects(existingManagedPath('tracks/link/private.mp3'), /outside/);
  } finally { await rm(outside, { recursive: true, force: true }); }
});
test('1,001-song library uses paginated queries and individual metadata lookup', async () => {
  transaction(() => {
    const statement = db.prepare(`INSERT INTO tracks(id,hash,title,artist,album,duration,original,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < 1001; i++) statement.run(`scale-${i}`, `scale-hash-${i}`, `Scale song ${String(i).padStart(4, '0')}`, 'Scale artist', '', 180, `tracks/scale-${i}/original.mp3`, 1, new Date(1700000000000 + i).toISOString());
  });
  const state = await (await call('state?q=Scale%20song&page=11&limit=100')).json();
  assert.equal(state.total, 1001); assert.equal(state.tracks.length, 1);
  const detail = await (await call('tracks/scale-0', 'GET', undefined, false)).json();
  assert.equal(detail.track.title, 'Scale song 0000');
  assert.equal('original' in detail.track, false);
});

test('word alignment is disabled by default and lyric saves do not schedule processing', async () => {
  delete process.env.KARAOKE_EXPERIMENTAL_WORD_ALIGNMENT;
  const id = await seed('Line timing only');
  const lyrics = { kind: 'line' as const, plain: 'Sing now', lines: [{ text: 'Sing now', start: 0, end: 2 }] };
  await saveLyrics(id, lyrics);
  assert.equal((db.prepare('SELECT COUNT(*) as n FROM alignment_jobs WHERE track_id=?').get(id) as { n: number }).n, 0);
  assert.equal((await call(`tracks/${id}/alignment`, 'POST', { action: 'start' })).status, 409);
  assert.equal((await (await call('state')).json()).wordAlignmentEnabled, false);
  assert.deepEqual(JSON.parse(getTrack(id)!.lyrics), lyrics);
});
test('opt-in word alignment is admin-only, durable, deduplicated, cancelable, and leaves prepared audio ready', async (t) => {
  process.env.KARAOKE_EXPERIMENTAL_WORD_ALIGNMENT = '1';
  t.after(() => { delete process.env.KARAOKE_EXPERIMENTAL_WORD_ALIGNMENT; });
  const id = await seed('Word tracking');
  assert.equal((await call(`tracks/${id}/alignment`, 'POST', { action: 'start' }, false)).status, 401);
  assert.equal((await call(`tracks/${id}/alignment`, 'POST', { action: 'start' })).status, 409);
  await saveLyrics(id, { kind: 'line', plain: 'Sing now', lines: [{ text: 'Sing now', start: 0, end: 2 }] });
  let job = db.prepare('SELECT * FROM alignment_jobs WHERE track_id=? ORDER BY rowid DESC LIMIT 1').get(id) as { id: string; status: string; lyrics_snapshot: string; guide_snapshot: string };
  assert.equal(job.status, 'queued');
  assert.equal(getTrack(id)!.status, 'ready');
  assert.equal((await call(`tracks/${id}/alignment`, 'POST', { action: 'start' })).status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) as n FROM alignment_jobs WHERE track_id=? AND status IN ('queued','running')").get(id) as { n: number }).n, 1);
  job = db.prepare('SELECT * FROM alignment_jobs WHERE track_id=? ORDER BY rowid DESC LIMIT 1').get(id) as typeof job;
  db.prepare("UPDATE alignment_jobs SET status='running' WHERE id=?").run(job.id);
  const aligned = { kind: 'word' as const, plain: 'Sing now', lines: [{ text: 'Sing now', start: 0, end: 2, words: [{ text: 'Sing', start: 0.1, end: 0.4 }, { text: 'now', start: 0.7, end: 1.5 }] }] };
  await saveLyrics(id, aligned, job);
  assert.equal(JSON.parse(getTrack(id)!.lyrics).kind, 'word');
  assert.equal((db.prepare('SELECT status FROM alignment_jobs WHERE id=?').get(job.id) as { status: string }).status, 'completed');
  await saveLyrics(id, { kind: 'line', plain: 'New lyrics', lines: [{ text: 'New lyrics', start: 0, end: 2 }] });
  await assert.rejects(saveLyrics(id, aligned, job), /changed/);
  assert.equal(JSON.parse(getTrack(id)!.lyrics).plain, 'New lyrics');
  assert.equal((await call(`tracks/${id}/alignment`, 'POST', { action: 'cancel' })).status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) as n FROM alignment_jobs WHERE track_id=? AND status IN ('queued','running')").get(id) as { n: number }).n, 0);
  assert.equal(getTrack(id)!.status, 'ready');
});

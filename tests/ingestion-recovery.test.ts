import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(os.tmpdir(), 'karaoke-recovery-'));
process.env.KARAOKE_DATA_DIR = temp;
const sources = path.join(temp, 'sources');
await mkdir(sources);
process.env.KARAOKE_IMPORT_ROOTS = sources;
const { db, getTrack, setting } = await import('../src/server/db');
const { importFolder } = await import('../src/server/ingest');
after(async () => { db.close(); await rm(temp, { recursive: true, force: true }); });

test('all five audio formats import with tags, duplicate detection, and allowed-root enforcement', async t => {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  try { execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' }); }
  catch { t.skip('FFmpeg is required for audio ingestion fixtures'); return; }
  for (const ext of ['mp3', 'wav', 'flac', 'm4a', 'ogg']) {
    // Pin the Ogg codec: FFmpeg's default depends on the build (Vorbis with libvorbis, otherwise FLAC-in-Ogg, whose tags music-metadata ignores).
    const codec = ext === 'ogg' ? ['-c:a', 'libopus'] : [];
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', ...codec, '-metadata', 'title=Format fixture', '-metadata', 'artist=Test singer', path.join(sources, `fixture.${ext}`)], { stdio: 'pipe' });
  }
  assert.deepEqual(await importFolder(sources, 'balanced'), { added: 5, duplicates: 0, errors: [] });
  assert.deepEqual(await importFolder(sources, 'balanced'), { added: 0, duplicates: 5, errors: [] });
  const rows = db.prepare('SELECT title,artist,duration,original FROM tracks').all() as { title: string; artist: string; duration: number; original: string }[];
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.title, 'Format fixture');
    assert.equal(row.artist, 'Test singer');
    assert.ok(row.duration >= 0.9 && row.duration < 1.2);
  }
  await assert.rejects(importFolder(os.tmpdir(), 'balanced'), /not in KARAOKE_IMPORT_ROOTS/);
});

test('worker restart requeues interrupted work and removes incomplete generations while preserving committed stems', async () => {
  // Independent of FFmpeg availability: the worker must recover before loading a model.
  const id = 'recovery-track';
  const dir = path.join(temp, 'tracks', id);
  await mkdir(path.join(dir, 'generation-complete'), { recursive: true });
  await mkdir(path.join(dir, 'generation-interrupted', '.separation-partial'), { recursive: true });
  db.prepare(`INSERT INTO tracks(id,hash,title,artist,album,duration,original,bytes,created_at,status,generation) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, id, 'Recovery', 'Test', '', 1, `tracks/${id}/original.mp3`, 1, new Date().toISOString(), 'running', 'generation-complete');
  db.prepare(`INSERT INTO jobs(id,track_id,status,quality,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(id, id, 'running', 'balanced', new Date().toISOString(), new Date().toISOString());
  const worker = spawn(process.execPath, ['--import', 'tsx', 'src/worker/index.ts'], { env: { ...process.env, KARAOKE_SCNET_MODEL: path.join(temp, 'absent.onnx') }, stdio: 'ignore' });
  const exited = once(worker, 'exit');
  try {
    const deadline = Date.now() + 10000;
    while (!setting('worker') && Date.now() < deadline && worker.exitCode === null) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(setting('worker'), 'worker should publish its heartbeat');
    assert.equal(getTrack(id)!.status, 'queued');
    assert.equal((db.prepare('SELECT status FROM jobs WHERE id=?').get(id) as { status: string }).status, 'queued');
    await access(path.join(dir, 'generation-complete'));
    await assert.rejects(access(path.join(dir, 'generation-interrupted')));
  } finally {
    worker.kill('SIGTERM');
    const force = setTimeout(() => worker.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(force);
  }
});

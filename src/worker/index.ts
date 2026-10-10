import { open, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, db, getTrack, publicTrack, managedPath, existingManagedPath, setSetting, setting, transaction } from '../server/db';
import { lookupLyrics } from '../server/lyrics';
import { saveLyrics } from '../server/api';
import { modelStatus, separateAudio } from './separation';
import { alignLyrics } from './alignment';
import { queueAlignment, wordAlignmentEnabled } from '../server/alignment-jobs';
import type { Lyrics } from '../lib/types';

type Job = { id: string; track_id: string; quality: 'balanced' | 'high'; status: string };
const lock = path.join(DATA_DIR, 'worker.lock');
let shutdown = false;
let current: AbortController | null = null;
let lastModelCheck = 0;
let cachedModel = { ready: false, error: null as string | null };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function acquireLock() {
  try {
    const existing = Number(await readFile(lock, 'utf8'));
    if (existing) {
      try { process.kill(existing, 0); throw new Error(`A preparation worker is already running (PID ${existing}).`); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    }
    await rm(lock, { force: true });
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const file = await open(lock, 'wx');
  await file.writeFile(String(process.pid)); await file.close();
}
function jobStillRunning(id: string) {
  return (db.prepare('SELECT status FROM jobs WHERE id=?').get(id) as { status: string } | undefined)?.status === 'running';
}
function playbackActive() {
  try { return (JSON.parse(setting('active_session') || 'null')?.expiresAt || 0) > Date.now(); } catch { return false; }
}
async function heartbeat(processing: boolean) {
  if (!processing && Date.now() - lastModelCheck > 60000) {
    lastModelCheck = Date.now();
    try { cachedModel = await modelStatus(); } catch (error) { cachedModel = { ready: false, error: error instanceof Error ? error.message : 'Model could not be loaded.' }; }
  }
  setSetting('worker', JSON.stringify({ updated: Date.now(), processing, modelReady: cachedModel.ready, modelError: cachedModel.error }));
  return cachedModel;
}
async function prepare(job: Job) {
  const track = getTrack(job.track_id);
  if (!track) return;
  const generation = `generation-${job.id}`;
  const dir = path.join(DATA_DIR, 'tracks', track.id, generation);
  current = new AbortController();
  const controller = current;
  let committed = false;
  const watch = setInterval(() => {
    if (!jobStillRunning(job.id) || !getTrack(track.id)) controller.abort(new Error('Preparation canceled.'));
    void heartbeat(true).catch(console.error);
  }, 1000);
  const lyricsTask = publicTrack(track).lyrics.kind === 'missing' ? lookupLyrics(track).then(async lyrics => {
    if (getTrack(track.id) && !controller.signal.aborted) await saveLyrics(track.id, lyrics, undefined, true);
  }).catch(error => console.info(`[lyrics] ${track.title}: ${error instanceof Error ? error.message : error}`)) : Promise.resolve();
  try {
    const result = await separateAudio(await existingManagedPath(track.original), dir, { quality: job.quality, signal: controller.signal, onProgress: fraction => {
      if (jobStillRunning(job.id)) db.prepare("UPDATE tracks SET progress=? WHERE id=? AND status='running'").run(Math.min(0.99, Math.max(0, fraction)), track.id);
    } });
    if (!jobStillRunning(job.id) || controller.signal.aborted || shutdown) throw new Error('Preparation interrupted.');
    const backing = path.relative(DATA_DIR, result.backing), guide = path.relative(DATA_DIR, result.guide);
    if (!path.resolve(result.backing).startsWith(dir + path.sep) || !path.resolve(result.guide).startsWith(dir + path.sep)) throw new Error('Separation outputs are outside the job directory.');
    const sizes = await Promise.all([stat(result.backing), stat(result.guide), stat(managedPath(track.original))]);
    if (sizes[0].size < 100 || sizes[1].size < 100) throw new Error('Separation produced empty audio.');
    transaction(() => {
      if (!jobStillRunning(job.id) || !getTrack(track.id)) throw new Error('Preparation canceled.');
      db.prepare("UPDATE tracks SET backing=?,guide=?,status='ready',progress=1,error=NULL,bytes=?,model=?,generation=? WHERE id=?").run(backing, guide, sizes.reduce((sum, s) => sum + s.size, 0), result.model, generation, track.id);
      db.prepare("UPDATE jobs SET status='completed',updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
    });
    committed = true;
    if (track.generation && track.generation !== generation) await rm(path.join(DATA_DIR, 'tracks', track.id, track.generation), { recursive: true, force: true });
    console.info(`[worker] Ready: ${track.title}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Audio preparation failed.';
    if (jobStillRunning(job.id)) transaction(() => {
      const status = shutdown ? 'queued' : 'failed';
      db.prepare('UPDATE jobs SET status=?,error=?,updated_at=? WHERE id=?').run(status, shutdown ? null : message, new Date().toISOString(), job.id);
      db.prepare('UPDATE tracks SET status=?,error=? WHERE id=?').run(shutdown ? 'queued' : track.backing && track.guide ? 'ready' : 'failed', shutdown ? null : message, track.id);
    });
    console.error(`[worker] ${track.title}: ${message}`);
  } finally {
    clearInterval(watch);
    await lyricsTask;
    if (committed) {
      try { queueAlignment(track.id); } catch (error) { console.info('[alignment]', error instanceof Error ? error.message : error); }
    }
    if (!committed) await rm(dir, { recursive: true, force: true });
    current = null;
  }
}
type AlignmentJob = { id: string; track_id: string; lyrics_snapshot: string; guide_snapshot: string };
async function align(job: AlignmentJob) {
  current = new AbortController();
  const controller = current;
  const stillRunning = () => (db.prepare('SELECT status FROM alignment_jobs WHERE id=?').get(job.id) as { status: string } | undefined)?.status === 'running';
  const watch = setInterval(() => {
    const track = getTrack(job.track_id);
    if (!stillRunning() || !track || track.lyrics !== job.lyrics_snapshot || track.guide !== job.guide_snapshot) controller.abort(new Error('Lyrics, audio or alignment job changed.'));
    void heartbeat(true).catch(console.error);
  }, 1000);
  try {
    const result = await alignLyrics(await existingManagedPath(job.guide_snapshot), JSON.parse(job.lyrics_snapshot) as Lyrics, {
      signal: controller.signal,
      onProgress: fraction => db.prepare("UPDATE alignment_jobs SET progress=?,updated_at=? WHERE id=? AND status='running'").run(Math.max(0, Math.min(0.99, fraction)), new Date().toISOString(), job.id),
    });
    controller.signal.throwIfAborted();
    if (shutdown) throw new Error('Worker stopping.');
    const enriched: Lyrics = { ...result, alignment: { ...result.alignment, model: result.alignment?.model ?? 'local-ctc', language: 'en', alignedLines: result.lines.filter(line => line.words?.length).length, totalLines: result.lines.filter(line => line.text.trim()).length, createdAt: new Date().toISOString() } };
    await saveLyrics(job.track_id, enriched, job);
    console.info(`[alignment] Word timings saved for ${getTrack(job.track_id)?.title ?? job.track_id}`);
  } catch (error) {
    if (stillRunning()) {
      const track = getTrack(job.track_id);
      const stale = !track || track.lyrics !== job.lyrics_snapshot || track.guide !== job.guide_snapshot;
      db.prepare('UPDATE alignment_jobs SET status=?,error=?,updated_at=? WHERE id=?').run(shutdown ? 'queued' : stale ? 'canceled' : 'failed', shutdown || stale ? null : error instanceof Error ? error.message : 'Word alignment failed.', new Date().toISOString(), job.id);
    }
    console.info('[alignment]', error instanceof Error ? error.message : error);
  } finally { clearInterval(watch); current = null; }
}
async function main() {
  await acquireLock();
  try {
    transaction(() => {
      db.prepare("UPDATE tracks SET status='queued',progress=0 WHERE id IN (SELECT track_id FROM jobs WHERE status='running')").run();
      db.prepare("UPDATE jobs SET status='queued',updated_at=? WHERE status='running'").run(new Date().toISOString());
      db.prepare("UPDATE alignment_jobs SET status='queued',progress=0,updated_at=? WHERE status='running'").run(new Date().toISOString());
      if (!wordAlignmentEnabled()) db.prepare("UPDATE alignment_jobs SET status='canceled',error=NULL,updated_at=? WHERE status IN ('queued','running')").run(new Date().toISOString());
    });
    // A killed process cannot run its cleanup. Preserve the committed stems and
    // remove only unused generations after acquiring exclusive worker ownership.
    for (const track of db.prepare('SELECT id,generation FROM tracks').all() as { id: string; generation: string | null }[]) {
      try {
        const dir = await existingManagedPath(path.join('tracks', track.id));
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith('generation-') && entry.name !== track.generation) {
            await rm(path.join(dir, entry.name), { recursive: true, force: true });
          }
        }
      } catch (error) {
        console.info(`[worker] Could not clean unused generations for ${track.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
    console.info('[worker] Local preparation worker started.');
    while (!shutdown) {
      const model = await heartbeat(false);
      if (wordAlignmentEnabled() && !playbackActive()) {
        const next = transaction(() => {
          const job = db.prepare("SELECT * FROM alignment_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get() as AlignmentJob | undefined;
          if (job) db.prepare("UPDATE alignment_jobs SET status='running',progress=0,error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
          return job;
        });
        if (next) { await align(next); continue; }
      }
      if (model.ready && !playbackActive()) {
        const job = transaction(() => {
          const next = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1").get() as Job | undefined;
          if (next) {
            db.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=?").run(new Date().toISOString(), next.id);
            db.prepare("UPDATE tracks SET status='running',progress=0,error=NULL WHERE id=?").run(next.track_id);
          }
          return next;
        });
        if (job) { await prepare(job); continue; }
      }
      await delay(1000);
    }
  } finally {
    setSetting('worker', JSON.stringify({ updated: 0, processing: false, modelReady: false, modelError: 'Preparation worker is stopped.' }));
    await rm(lock, { force: true });
    db.close();
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { shutdown = true; current?.abort(new Error('Worker stopping.')); });
void main().catch(error => { console.error(error); process.exitCode = 1; });

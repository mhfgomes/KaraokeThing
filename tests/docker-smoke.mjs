// Run inside a fresh test container after installing its model. This exercises
// the shipped server/worker bundles and audio build, rather than source modules.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

assert.equal(process.env.KARAOKE_DOCKER_SMOKE, '1', 'Use an isolated test library and set KARAOKE_DOCKER_SMOKE=1.');
const origin = `http://127.0.0.1:${process.env.PORT || 3100}`;
const initial = await (await fetch(`${origin}/api/state`)).json();
assert.equal(initial.setupRequired, true, 'Smoke tests require a fresh library.');
assert.equal(initial.worker.modelReady, true, 'Install the model before running smoke tests.');

const auth = await fetch(`${origin}/api/auth`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'setup', password: 'isolated-docker-test-password' }),
});
assert.equal(auth.status, 200);
const cookie = auth.headers.get('set-cookie').split(';')[0];
const root = await mkdtemp(path.join(os.tmpdir(), 'karaoke-docker-smoke-'));
try {
  const form = new FormData();
  for (const extension of ['mp3', 'wav', 'flac', 'm4a', 'ogg']) {
    const file = path.join(root, `fixture.${extension}`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      ...(extension === 'ogg' ? ['-c:a', 'libopus'] : []), file]);
    // Decode every supported format with the reduced FFmpeg build.
    execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', `${file}.pcm`]);
    assert.ok((await readFile(`${file}.pcm`)).length > 0);
    form.append('files', new Blob([await readFile(file)]), path.basename(file));
  }
  // Container extensions can carry several codecs. Check common alternatives
  // too, including compressed WAVs that need more than a PCM decoder.
  for (const [extension, codec] of [['m4a', 'alac'], ['wav', 'adpcm_ima_wav'], ['ogg', 'vorbis'], ['wav', 'pcm_f32le']]) {
    const file = path.join(root, `${codec}.${extension}`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ac', '2', '-c:a', codec, '-strict', '-2', file]);
    execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', `${file}.pcm`]);
    assert.ok((await readFile(`${file}.pcm`)).length > 0, `Decode ${codec}`);
  }
  const response = await fetch(`${origin}/api/upload`, { method: 'POST', headers: { origin, cookie }, body: form });
  assert.equal(response.status, 200);
  const upload = await response.json();
  assert.equal(upload.added, 5, JSON.stringify(upload));
  assert.deepEqual(upload.errors, []);

  const deadline = Date.now() + 180_000;
  let tracks;
  while (Date.now() < deadline) {
    const state = await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json();
    tracks = state.tracks;
    assert.equal(state.worker.online, true);
    assert.ok(tracks.every(track => track.status !== 'failed'), JSON.stringify(tracks));
    if (tracks.length === 5 && tracks.every(track => track.status === 'ready')) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(tracks.length, 5);
  assert.ok(tracks.every(track => track.status === 'ready'), 'Preparation must finish for all five formats.');
  for (const track of tracks) {
    const frames = [];
    for (const stem of ['backing', 'guide']) {
      const media = await fetch(`${origin}/api/media/${track.id}/${stem}`, { headers: { range: 'bytes=0-' } });
      assert.equal(media.status, 206);
      const file = path.join(root, `${track.id}-${stem}.mp3`);
      await writeFile(file, new Uint8Array(await media.arrayBuffer()));
      execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', `${file}.pcm`]);
      frames.push((await readFile(`${file}.pcm`)).length);
    }
    assert.ok(frames[0] > 0);
    assert.equal(frames[0], frames[1], 'Prepared stems must have matching decoded lengths.');
  }
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  const asset = html.match(/(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/)?.[1];
  assert.ok(asset, 'The page must reference a bundled static asset.');
  assert.equal((await fetch(new URL(asset, origin))).status, 200);
  console.log('Docker smoke passed: five formats decoded, uploaded and prepared; aligned stems, media ranges, page and static assets served.');
} finally {
  await rm(root, { recursive: true, force: true });
}

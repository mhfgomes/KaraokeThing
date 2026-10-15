import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const temp = await mkdtemp(path.join(os.tmpdir(), 'karaoke-stage-test-'));
process.env.KARAOKE_DATA_DIR = temp;
const { handleApi } = await import('../src/server/api');
const { db } = await import('../src/server/db');
after(async () => { db.close(); await rm(temp, { recursive: true, force: true }); });

let cookie = '';
async function call(route: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) {
  const response = await handleApi(new Request(`http://localhost:3000/api/${route}`, {
    method, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), route.split('/'));
  return { status: response.status, body: await response.json() };
}
const admin = (route: string, method = 'GET', data?: unknown) => call(route, method, data, { cookie });
const idle = { trackId: null, transport: 'idle', position: 0, duration: 0, loadProgress: 0, error: null, hasGuide: false, soundBlocked: false, micSupported: true, devices: [], mics: [] };
function seed() {
  const id = randomUUID();
  db.prepare(`INSERT INTO tracks(id,hash,title,artist,album,duration,original,backing,guide,status,bytes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, randomUUID(), 'Stage song', 'Artist', '', 200, `tracks/${id}/original.mp3`, `tracks/${id}/backing.mp3`, `tracks/${id}/guide.mp3`, 'ready', 1, new Date().toISOString());
  return id;
}

test('stage display pairing, remote transport, lease sharing, and mixer settings', async () => {
  const setup = await handleApi(new Request('http://localhost:3000/api/auth', { method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'setup', password: 'stage-password' }) }), ['auth']);
  cookie = setup.headers.get('set-cookie')!.split(';')[0];

  assert.equal((await call('stage')).status, 401, 'visitors cannot read the pairing key');
  const { body: initial } = await admin('stage');
  assert.equal(initial.connected, false);
  assert.ok(initial.key.length >= 20);
  assert.equal((await call('stage/report', 'POST', idle)).status, 401);
  assert.equal((await call('stage/report', 'POST', idle, { 'x-stage-key': 'wrong' })).status, 401);

  const track = seed();
  assert.equal((await admin('stage', 'POST', { action: 'load', trackId: track })).status, 409, 'nothing to play on without a display');
  const key = { 'x-stage-key': initial.key };
  let feed = await call('stage/report', 'POST', idle, key);
  assert.equal(feed.status, 200);
  assert.equal(feed.body.desired.trackId, null);
  assert.equal((await admin('stage')).body.connected, true);

  await admin('queue', 'POST', { trackId: track, singer: 'Ana' });
  const entry = (await admin('state')).body.queue[0];
  let res = await admin('stage', 'POST', { action: 'load', trackId: track, entryId: entry.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.desired.trackId, track);
  assert.equal(res.body.desired.singer, 'Ana');
  assert.equal(res.body.desired.playing, true);
  const state = (await admin('state')).body;
  assert.equal(state.queue.length, 0, 'starting a queue entry removes it');
  assert.equal(state.active.controller, 'stage-display');
  assert.equal((await admin('session', 'POST', { action: 'claim', controller: 'browser-controller', trackId: track })).status, 409, 'browsers wait for the display');
  assert.equal((await admin(`tracks/${track}`, 'DELETE')).status, 409);

  feed = await call('stage/report', 'POST', { ...idle, trackId: track, transport: 'playing', position: 42, duration: 200, hasGuide: true }, key);
  assert.equal(feed.body.desired.transportRev, res.body.desired.transportRev);
  res = await admin('stage', 'POST', { action: 'pause' });
  assert.equal(res.body.desired.playing, false);
  assert.ok(res.body.desired.position >= 42 && res.body.desired.position < 44, 'pause keeps the reported position');
  assert.ok(res.body.desired.transportRev > feed.body.desired.transportRev);
  res = await admin('stage', 'POST', { action: 'seek', position: 90 });
  assert.equal(res.body.desired.position, 90);

  const before = res.body.desired.transportRev;
  res = await admin('stage', 'POST', { action: 'mix', mix: { guideGain: 0.5, mics: [{ enabled: true, mode: 'left' }, {}] } });
  assert.equal(res.body.desired.guideGain, 0.5);
  assert.equal(res.body.desired.mics[0].enabled, true);
  assert.equal(res.body.desired.mics[0].mode, 'left');
  assert.equal(res.body.desired.mics[1].enabled, false);
  assert.equal(res.body.desired.transportRev, before, 'mixer changes do not replay transport');
  assert.equal((await admin('stage', 'POST', { action: 'mix', mix: { guideGain: 9 } })).status, 400);

  res = await admin('stage', 'POST', { action: 'stop' });
  assert.equal(res.body.desired.trackId, null);
  assert.equal((await admin('state')).body.active, null);
  assert.equal((await admin('session', 'POST', { action: 'claim', controller: 'browser-controller', trackId: track })).status, 200);
  assert.equal((await admin('stage', 'POST', { action: 'load', trackId: track })).status, 409, 'the display waits for a browser song');
  await admin('session', 'POST', { action: 'release', controller: 'browser-controller' });

  await admin('stage', 'POST', { action: 'rotateKey' });
  assert.equal((await call('stage/report', 'POST', idle, key)).status, 401, 'old links stop working');
  assert.equal((await admin('stage')).body.connected, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, isLeaseLost, newControllerId } from '../src/lib/client-api';
import { outputDelaySeconds } from '../src/lib/lyric-timing';
import { TrackCache } from '../src/lib/track-cache';
import type { Track } from '../src/lib/types';

const track = (id: string, patch: Partial<Track> = {}): Track => ({
  id, title: id, artist: 'A', album: '', duration: 1, status: 'ready', favorite: false, progress: 1, error: null,
  quality: 'balanced', lyrics: { kind: 'missing', lines: [], plain: '' }, lyricOffset: 0, createdAt: '', bytes: 0, ...patch,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

test('only 401 and 409 count as losing the playback lease', () => {
  assert.equal(isLeaseLost(new ApiError('x', 401)), true);
  assert.equal(isLeaseLost(new ApiError('x', 409)), true);
  assert.equal(isLeaseLost(new ApiError('offline', 0)), false);
  assert.equal(isLeaseLost(new ApiError('busy', 503)), false);
  assert.equal(isLeaseLost(new Error('x')), false);
});

test('controller ids are random and long enough for the server', () => {
  const a = newControllerId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newControllerId());
});

test('output delay sums reported latencies and ignores missing values', () => {
  assert.equal(outputDelaySeconds(null, undefined), 0);
  assert.ok(Math.abs(outputDelaySeconds(0.01, 0.2) - 0.21) < 1e-9);
  assert.equal(outputDelaySeconds(0.01, Number.NaN), 0.01);
  assert.equal(outputDelaySeconds(-1, 5), 1, 'clamped to a sane maximum');
});

test('track cache fetches each id independently and remembers 404s', async () => {
  const calls: string[] = [];
  const cache = new TrackCache(async (id) => {
    calls.push(id);
    if (id === 'bad') throw new Error('network');
    if (id === 'gone') return null;
    return track(id);
  });
  cache.sync([{ id: 'bad', maxAgeMs: 1000 }, { id: 'gone', maxAgeMs: 1000 }, { id: 'ok', maxAgeMs: 1000 }]);
  await flush();
  assert.deepEqual(calls.sort(), ['bad', 'gone', 'ok']);
  assert.equal(cache.get('ok')?.id, 'ok', 'one failure does not block the others');
  assert.equal(cache.isGone('gone'), true);
  calls.length = 0;
  cache.sync([{ id: 'bad', maxAgeMs: 1000 }, { id: 'gone', maxAgeMs: 1000 }, { id: 'ok', maxAgeMs: 1000 }]);
  await flush();
  assert.deepEqual(calls, [], 'fresh, gone, and recently failed ids are not refetched');
});

test('track cache refreshes stale ids, picks up new ids mid-fetch, and retries failures later', async () => {
  let clock = 0;
  let title = 'v1';
  let release: () => void = () => undefined;
  const calls: string[] = [];
  const cache = new TrackCache(async (id) => {
    calls.push(id);
    if (id === 'slow') await new Promise<void>((r) => { release = r; });
    if (id === 'flaky' && clock < 10_000) throw new Error('busy');
    return track(id, { title });
  }, () => clock);
  cache.sync([{ id: 'slow', maxAgeMs: 3000 }]);
  cache.sync([{ id: 'slow', maxAgeMs: 3000 }, { id: 'new', maxAgeMs: 3000 }, { id: 'flaky', maxAgeMs: 3000 }]);
  await flush();
  assert.deepEqual(calls, ['slow', 'new', 'flaky'], 'in-flight ids are not duplicated; new ids start at once');
  release();
  await flush();
  assert.equal(cache.get('slow')?.title, 'v1');

  calls.length = 0;
  title = 'v2';
  clock = 10_000;
  cache.sync([{ id: 'slow', maxAgeMs: 3000 }, { id: 'flaky', maxAgeMs: 3000 }]);
  release();
  await flush();
  assert.deepEqual(calls.sort(), ['flaky', 'slow']);
  assert.equal(cache.get('slow')?.title, 'v2', 'stale entries are refetched');
  assert.equal(cache.get('flaky')?.title, 'v2', 'failures are retried after a pause');
});

test('track cache drops long-unwanted entries and applies confirmed patches', () => {
  let clock = 0;
  const cache = new TrackCache(async () => null, () => clock);
  cache.seen([track('a'), track('b')]);
  cache.patch('a', { lyricOffset: 0.5 });
  assert.equal(cache.get('a')?.lyricOffset, 0.5);
  clock = 120_000;
  cache.sync([{ id: 'a', maxAgeMs: Infinity }]);
  assert.ok(cache.get('a'));
  assert.equal(cache.get('b'), undefined);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { modelStatus, overlapWeight, pcmStatistics, SCNET, separateAudio, sha256File } from './separation';

test('streaming normalization matches whole-track stereo mono sample statistics', () => {
  const pcm = Buffer.alloc(32);
  [1, 3, 2, 4, -1, 1, 0, 2].forEach((value, i) => pcm.writeFloatLE(value, i * 4));
  const whole = pcmStatistics(pcm);
  const split = pcmStatistics(pcm.subarray(16), pcmStatistics(pcm.subarray(0, 16)));
  assert.deepEqual(split, whole);
  assert.equal(whole.mean, 1.5);
  assert.ok(Math.abs(whole.m2 - 5) < 1e-12);
  pcm.writeFloatLE(NaN, 0);
  assert.throws(() => pcmStatistics(pcm), /non-finite/);
});
test('overlap windows have full weight at track edges and no uncovered interior', () => {
  const n = 1000, step = 250;
  assert.equal(overlapWeight(0, n, true, false), 1);
  assert.equal(overlapWeight(n - 1, n, false, true), 1);
  assert.equal(overlapWeight(0, n, false, false), 0);
  for (let i = step; i < n; i++) assert.ok(overlapWeight(i, n, true, false) + overlapWeight(i - step, n, false, true) > 0);
});
test('missing model reports actionable failure; pre-aborted job creates nothing', async () => {
  const original = process.env.KARAOKE_SCNET_MODEL;
  const hash = process.env.KARAOKE_SCNET_SHA256;
  process.env.KARAOKE_SCNET_MODEL = path.join(os.tmpdir(), 'nonexistent-karaoke-test.onnx');
  process.env.KARAOKE_SCNET_SHA256 = SCNET.sha256;
  try {
    const status = await modelStatus();
    assert.equal(status.ready, false); assert.match(status.error!, /missing/);
    await assert.rejects(separateAudio('missing', 'missing', { quality: 'balanced', signal: AbortSignal.abort(new Error('canceled')), onProgress() {} }), /canceled/);
  } finally {
    if (original === undefined) delete process.env.KARAOKE_SCNET_MODEL; else process.env.KARAOKE_SCNET_MODEL = original;
    if (hash === undefined) delete process.env.KARAOKE_SCNET_SHA256; else process.env.KARAOKE_SCNET_SHA256 = hash;
  }
});
test('real CPU model, disk overlap, aligned MP3 outputs, monotonic progress and cancellation', { skip: !process.env.KARAOKE_TEST_INFERENCE, timeout: 300_000 }, async () => {
  assert.deepEqual(await modelStatus(), { ready: true, error: null });
  if (!process.env.KARAOKE_SCNET_MODEL) assert.equal(await sha256File(path.resolve(process.env.KARAOKE_DATA_DIR || 'data', 'models/scnet/scnet.int8.onnx')), SCNET.sha256);
  const root = await mkdtemp(path.join(os.tmpdir(), 'karaoke-separation-test-'));
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const duration = Number(process.env.KARAOKE_TEST_SECONDS || 12);
  const input = path.join(root, 'input.wav');
  const frames = Math.floor(duration * 44100);
  const pcm = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) {
    const shared = 0.08 * Math.sin(2 * Math.PI * 220 * i / 44100);
    pcm.writeFloatLE(shared + 0.04 * Math.sin(2 * Math.PI * 440 * i / 44100), i * 8);
    pcm.writeFloatLE(shared + 0.03 * Math.sin(2 * Math.PI * 660 * i / 44100), i * 8 + 4);
  }
  await writeFile(path.join(root, 'input.f32'), pcm);
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', path.join(root, 'input.f32'), input]);
  try {
    const progress: number[] = [];
    const began = Date.now();
    const result = await separateAudio(input, root, { quality: process.env.KARAOKE_TEST_QUALITY === 'high' ? 'high' : 'balanced', signal: new AbortController().signal, onProgress: p => progress.push(p) });
    assert.match(result.model, /scnet/);
    assert.equal(progress.at(-1), 1);
    assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1])));
    const decoded: Buffer[] = [];
    for (const stem of [result.guide, result.backing]) {
      const output = `${stem}.f32`;
      execFileSync(ffmpeg, ['-v', 'error', '-i', stem, '-f', 'f32le', output]);
      decoded.push(await readFile(output));
    }
    assert.equal(decoded[0].length, frames * 8);
    assert.equal(decoded[1].length, frames * 8);
    let energy = 0, error = 0;
    for (let i = 0; i < pcm.length; i += 4) {
      const guide = decoded[0].readFloatLE(i), backing = decoded[1].readFloatLE(i);
      assert.ok(Number.isFinite(guide) && Number.isFinite(backing));
      energy += guide ** 2;
      error += (guide + backing - pcm.readFloatLE(i)) ** 2;
    }
    assert.ok(energy > 1e-8, 'real model produces a nonzero guide');
    assert.ok(Math.sqrt(error / (frames * 2)) < 0.015, 'sum of lossy encoded stems approximates input');
    const controller = new AbortController();
    await assert.rejects(separateAudio(input, root, { quality: 'high', signal: controller.signal, onProgress: p => { if (p > 0.05) controller.abort(new Error('test cancel')); } }), /test cancel/);
    assert.ok((await readdir(root)).every(name => !name.startsWith('.separation-')));
    console.log(JSON.stringify({ seconds: duration, wallSeconds: (Date.now() - began) / 1000, maxRssMiB: process.resourceUsage().maxRSS / 1024, guideRms: Math.sqrt(energy / (frames * 2)), sumErrorRms: Math.sqrt(error / (frames * 2)) }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

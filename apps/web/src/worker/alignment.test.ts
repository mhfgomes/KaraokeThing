import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { alignLyrics, alignmentModelStatus, alignmentSha256, alignmentTokens, forcedAlignCtc, NoAcceptedAlignmentError, normalizeAlignmentAudio, scoreAlignment } from './alignment';

function emissions(path: number[], size = 3) {
  const logits = new Float32Array(path.length * size).fill(-10);
  path.forEach((token, t) => { logits[t * size + token] = 10; });
  return logits;
}
test('CTC word boundaries follow acoustic frames and exclude blank gaps', async () => {
  const spans = await forcedAlignCtc(emissions([0, 1, 1, 0, 0, 2, 0]), 3, [1, 2]);
  assert.ok(spans);
  assert.deepEqual(spans.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[1, 3], [5, 6]]);
  assert.ok(spans.every(s => s.peakProbability > 0.99));
});
test('repeated labels need a separating blank, and cannot skip directly', async () => {
  const spans = await forcedAlignCtc(emissions([0, 1, 0, 1, 0]), 3, [1, 1]);
  assert.ok(spans);
  assert.deepEqual(spans.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [[1, 2], [3, 4]]);
  assert.equal(await forcedAlignCtc(emissions([1, 1]), 3, [1, 1]), null);
});
test('exact DP matches exhaustive CTC paths, including repeated labels', async () => {
  const rows = [[0.2, 1.2, -0.8], [-0.2, 0.5, 0.7], [1.1, 0.4, -0.3], [0.1, -0.3, 1.5], [0.3, 0.8, 0.2]];
  const logits = Float32Array.from(rows.flat());
  for (const target of [[1, 2], [1, 1], [2, 1, 2]]) {
    let best = -Infinity;
    const optimal: number[][] = [];
    for (let i = 0; i < 3 ** rows.length; i++) {
      let n = i;
      const path = rows.map(() => { const v = n % 3; n = Math.floor(n / 3); return v; });
      const collapsed = path.filter((token, t) => token !== 0 && (t === 0 || token !== path[t - 1]));
      if (JSON.stringify(collapsed) !== JSON.stringify(target)) continue;
      const score = path.reduce((sum, v, t) => sum + rows[t][v], 0);
      if (score > best + 1e-6) { best = score; optimal.length = 0; optimal.push(path); }
      else if (Math.abs(score - best) < 1e-6) optimal.push(path);
    }
    const result = await forcedAlignCtc(logits, 3, target);
    assert.ok(result);
    assert.ok(optimal.some(p => {
      let token = -1, prior = 0;
      const boundaries = target.map(() => [Infinity, 0]);
      p.forEach((v, t) => { if (v) { if (v !== prior) token++; boundaries[token][0] = Math.min(boundaries[token][0], t); boundaries[token][1] = t + 1; } prior = v; });
      return JSON.stringify(boundaries) === JSON.stringify(result.map(s => [s.startFrame, s.endFrame]));
    }));
  }
});
test('silence or unsupported acoustic labels never become confident timings', async () => {
  const spans = await forcedAlignCtc(emissions([0, 0, 0, 0, 0, 0]), 3, [1, 2]);
  assert.ok(spans, 'forced paths exist even when text is absent');
  assert.equal(scoreAlignment(spans, [0, 1], 2, { minConfidence: 0.45, minWordConfidence: 0.25, minSupport: 0.8 }).accepted, false);
  const mixed = [{ startFrame: 0, endFrame: 1, peakProbability: 0.99 }, { startFrame: 1, endFrame: 2, peakProbability: 0.01 }];
  assert.equal(scoreAlignment(mixed, [0, 1], 2, { minConfidence: 0, minWordConfidence: 0.25, minSupport: 0 }).accepted, false);
});
test('token normalization retains exact display text, includes delimiters and rejects unsupported scripts/digits', () => {
  const tokens = alignmentTokens('Hello, don’t!');
  assert.ok(tokens);
  assert.deepEqual(tokens.words, ['Hello,', 'don’t!']);
  assert.equal(tokens.labels[tokens.wordForLabel.indexOf(-1)], 4);
  assert.equal(alignmentTokens('hello 123'), null);
  assert.equal(alignmentTokens('你好'), null);
  assert.equal(alignmentTokens('...'), null);
  assert.equal(alignmentTokens(''), null);
});
test('feature normalization matches population variance with epsilon and rejects nonfinite PCM', () => {
  const result = normalizeAlignmentAudio(Float32Array.from([1, 2, 3]));
  assert.ok(Math.abs(result[0] + 1 / Math.sqrt(2 / 3 + 1e-7)) < 1e-6);
  assert.equal(result[1], 0);
  assert.throws(() => normalizeAlignmentAudio(Float32Array.from([NaN])), /non-finite/);
});
test('abort before any model/audio access, and during DP yields', async () => {
  const signal = AbortSignal.abort(new Error('test cancellation'));
  await assert.rejects(alignLyrics('missing.mp3', { kind: 'line', plain: 'Hi', lines: [{ text: 'Hi', start: 0 }] }, { signal }), /test cancellation/);
  await assert.rejects(forcedAlignCtc(emissions([1]), 3, [1], 0, signal), /test cancellation/);
  const controller = new AbortController();
  setImmediate(() => controller.abort(new Error('mid DP cancellation')));
  await assert.rejects(forcedAlignCtc(emissions(Array(1000).fill(0)), 3, [1], 0, controller.signal), /mid DP cancellation/);
});
test('invalid emissions, blank target and memory bounds fail explicitly', async () => {
  await assert.rejects(forcedAlignCtc(Float32Array.from([NaN, 0, 1]), 3, [1]), /non-finite/);
  await assert.rejects(forcedAlignCtc(emissions([1]), 3, [0]), /Invalid/);
  await assert.rejects(forcedAlignCtc(emissions(Array(1201).fill(0)), 3, [1]), /bounded/);
});
test('missing model status is actionable and does not download automatically', async () => {
  const previous = process.env.KARAOKE_DATA_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'karaoke-alignment-missing-'));
  process.env.KARAOKE_DATA_DIR = root;
  try {
    const status = await alignmentModelStatus();
    assert.equal(status.ready, false);
    assert.match(status.error!, /Alignment model missing[\s\S]*install-alignment-model/);
  } finally {
    if (previous === undefined) delete process.env.KARAOKE_DATA_DIR; else process.env.KARAOKE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// Opt-in fixture: JFK 1961 inaugural address, public domain (JFK Library USG-17).
// The mirrored excerpt is immutable and independently SHA-256 checked. No real DB/track writes.
test('native CPU speech acceptance, mixed fallback, silence rejection and cancellation cleanup', { skip: !process.env.KARAOKE_TEST_ALIGNMENT_INFERENCE, timeout: 120_000 }, async () => {
  assert.deepEqual(await alignmentModelStatus(), { ready: true, error: null });
  const root = await mkdtemp(path.join(os.tmpdir(), 'karaoke-alignment-native-'));
  const audio = path.join(root, 'jfk.wav');
  try {
    const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/542437c29cc5273cfd29e25c77696f2b349badd7/jfk.wav', { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.ok, true);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, 1940478);
    await writeFile(audio, bytes);
    assert.equal(await alignmentSha256(audio), 'aa81c2552465568567e670f3823117e633900d16bd6202346a72f3c8464c74c8');
    const lines = [
      { text: 'And so my fellow Americans', start: 0, end: 2.4 },
      { text: '你好', start: 3, end: 4 },
      { text: 'what you can do for your country', start: 8.6, end: 11 },
    ];
    const lyrics = { kind: 'line' as const, plain: lines.map(l => l.text).join('\n'), lines };
    const original = JSON.stringify(lyrics), progress: number[] = [];
    const began = Date.now();
    const result = await alignLyrics(audio, lyrics, { onProgress: p => progress.push(p) });
    assert.equal(JSON.stringify(lyrics), original);
    assert.equal(result.kind, 'word');
    assert.equal(result.plain, lyrics.plain);
    assert.deepEqual(result.lines[1], lines[1]);
    assert.equal(progress.at(-1), 1);
    assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1])));
    const words = result.lines.flatMap(l => l.words || []);
    assert.equal(words.length, 12);
    assert.ok(words.every((w, i) => Number.isFinite(w.start) && w.end! > w.start && (i === 0 || w.start >= words[i - 1].end!)));
    assert.ok(Math.abs(words[0].start - 0.42) < 0.08);
    assert.ok(Math.abs(words.at(-1)!.end! - 10.4) < 0.15);
    assert.ok(Math.max(...words.map(w => w.end! - w.start)) > Math.min(...words.map(w => w.end! - w.start)) * 2, 'durations follow acoustics');
    const supplied = [{ text: 'And', start: 0.1, end: 0.3 }];
    const partial = { ...lyrics, kind: 'word' as const, lines: [{ ...lines[0], words: supplied }, ...lines.slice(1)] };
    const filled = await alignLyrics(audio, partial);
    assert.deepEqual(filled.lines[0].words, supplied, 'filling missing lines preserves supplied word timestamps');
    const silent = path.join(root, 'silence.wav');
    execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', silent]);
    await assert.rejects(alignLyrics(silent, { kind: 'line', plain: 'hello world', lines: [{ text: 'hello world', start: 0, end: 2 }] }), error => error instanceof NoAcceptedAlignmentError && error.diagnostics.every(l => !l.accepted));
    const controller = new AbortController();
    await assert.rejects(alignLyrics(audio, lyrics, { signal: controller.signal, onProgress: p => { if (p > 0) controller.abort(new Error('native alignment cancel')); } }), /native alignment cancel/);
    assert.equal(JSON.stringify(lyrics), original);
    // Full 11-second input crosses the inference chunk boundary; the speech model
    // mishears an "ask" token, so strict per-word rejection is the correct outcome.
    const fullText = 'And so my fellow Americans ask not what your country can do for you ask what you can do for your country';
    await assert.rejects(alignLyrics(audio, { kind: 'line', plain: fullText, lines: [{ text: fullText, start: 0, end: 11 }] }), error => error instanceof NoAcceptedAlignmentError && error.diagnostics[0].confidence! > 0.45);
    console.log(JSON.stringify({ nativeSpeechSeconds: (Date.now() - began) / 1000, maxRssMiB: process.resourceUsage().maxRSS / 1024, timings: words.map(w => [w.start, w.end]) }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

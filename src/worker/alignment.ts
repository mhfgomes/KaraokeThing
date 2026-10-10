import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { Lyrics, LyricWord } from '../lib/types';

const REVISION = 'a19f851b3d42865797e410752b4c570c871e4825';
const BASE = `https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/${REVISION}`;
export const ALIGNMENT_MODEL = {
  id: `Xenova/wav2vec2-base-960h@${REVISION}`,
  revision: REVISION,
  upstream: 'facebook/wav2vec2-base-960h@22aad52d435eb6dbaf354bdad9b0da84ce7d6156',
  license: 'Apache-2.0',
  files: [
    { name: 'model_quantized.onnx', url: `${BASE}/onnx/model_quantized.onnx`, bytes: 95286046, sha256: 'cd5040c147381580ed73258143dd8e0c28e800a09e74ee42ee2b3e8cb4d760a3' },
    { name: 'config.json', url: `${BASE}/config.json`, bytes: 2094, sha256: 'ceff8f92e6670ad3633779bd43b3559628c1a64b0868ef6046b23d62b85c69d5' },
    { name: 'vocab.json', url: `${BASE}/vocab.json`, bytes: 358, sha256: '4178db26b3c7570f6a47f14ac6a1c7b32950b8c2800fb097287e53776934f1c5' },
    { name: 'preprocessor_config.json', url: `${BASE}/preprocessor_config.json`, bytes: 215, sha256: '8cdfd65ff4115423185a1512bdae100e2e0cd744f5b322417429944aaafd0827' },
    { name: 'README.md', url: `${BASE}/README.md`, bytes: 1372, sha256: '6c235e53bdc82374bd10f9dbff5aad652c0e1c11eaaf9427d85a7c3adcd56fb8' },
    { name: 'upstream-README.md', url: 'https://huggingface.co/facebook/wav2vec2-base-960h/resolve/22aad52d435eb6dbaf354bdad9b0da84ce7d6156/README.md', bytes: 4431, sha256: 'fc52a0adfa64e446800f9944c6cf9b90da3127aba548860ea5714516ec8c18c7' },
    { name: 'LICENSE', url: 'https://www.apache.org/licenses/LICENSE-2.0.txt', bytes: 11358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  ],
} as const;

export const ALIGNMENT_VOCAB: Readonly<Record<string, number>> = {
  '<pad>': 0, '<s>': 1, '</s>': 2, '<unk>': 3, '|': 4,
  E: 5, T: 6, A: 7, O: 8, N: 9, I: 10, H: 11, S: 12, R: 13, D: 14,
  L: 15, U: 16, M: 17, W: 18, C: 19, F: 20, G: 21, Y: 22, P: 23,
  B: 24, V: 25, K: 26, "'": 27, X: 28, J: 29, Q: 30, Z: 31,
};
const RATE = 16000, STRIDE = 320, RECEPTIVE = 400, VOCAB_SIZE = 32;
const MAX_SECONDS = 24, MAX_LABELS = 512, CHUNK_SECONDS = 8, CONTEXT_SAMPLES = 10240;
export function alignmentModelDirectory() {
  return path.resolve(process.env.KARAOKE_DATA_DIR || 'data', 'models', 'alignment');
}
export async function alignmentSha256(file: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}
async function registeredModel(signal?: AbortSignal) {
  const root = alignmentModelDirectory();
  for (const artifact of ALIGNMENT_MODEL.files) {
    signal?.throwIfAborted();
    const file = path.join(root, artifact.name);
    let size: number;
    try { size = (await stat(file)).size; }
    catch { throw new Error(`Alignment model missing: ${file}. Run node --import tsx scripts/install-alignment-model.ts.`); }
    if (size !== artifact.bytes || await alignmentSha256(file, signal) !== artifact.sha256) {
      throw new Error(`Alignment model checksum mismatch: ${file}. Reinstall with node --import tsx scripts/install-alignment-model.ts.`);
    }
  }
  return path.join(root, ALIGNMENT_MODEL.files[0].name);
}
function setting(name: string, fallback: number, min: number, max: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}.`);
  return value;
}
/** Also used to validate a staged installer download before publishing it. */
export async function createAlignmentSession(file: string) {
  const ort = await import('onnxruntime-node');
  const threads = setting('KARAOKE_INFERENCE_THREADS', 2, 1, 64);
  if (!Number.isInteger(threads)) throw new Error('KARAOKE_INFERENCE_THREADS must be an integer.');
  const session = await ort.InferenceSession.create(file, {
    executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1,
    enableCpuMemArena: false, enableMemPattern: false,
  });
  const input = session.inputMetadata, output = session.outputMetadata;
  if (input.length !== 1 || input[0].name !== 'input_values' || !input[0].isTensor || input[0].type !== 'float32' || input[0].shape.length !== 2 ||
      output.length !== 1 || output[0].name !== 'logits' || !output[0].isTensor || output[0].type !== 'float32' || output[0].shape.length !== 3 || output[0].shape[2] !== VOCAB_SIZE) {
    await session.release();
    throw new Error('Incompatible alignment graph: expected input_values float32 [batch,samples] → logits float32 [batch,frames,32].');
  }
  return { ort, session };
}
export async function alignmentModelStatus(): Promise<{ ready: boolean; error: string | null }> {
  try {
    const { session } = await createAlignmentSession(await registeredModel());
    await session.release();
    return { ready: true, error: null };
  } catch (error) { return { ready: false, error: error instanceof Error ? error.message : String(error) }; }
}

/** Display strings stay intact. Unsupported alphabet/numbers reject the whole line. */
export function alignmentTokens(text: string) {
  const words = text.match(/\S+/g) || [];
  const labels: number[] = [], wordForLabel: number[] = [];
  for (const [index, word] of words.entries()) {
    const normalized = word.replace(/[’‘]/g, "'").toUpperCase().replace(/[.,!?;:"“”()\[\]{}…—–-]/g, '');
    if (!normalized || !/^[A-Z']+$/.test(normalized) || !/[A-Z]/.test(normalized)) return null;
    if (index) { labels.push(4); wordForLabel.push(-1); }
    for (const character of normalized) { labels.push(ALIGNMENT_VOCAB[character]); wordForLabel.push(index); }
  }
  return labels.length && labels.length <= MAX_LABELS ? { words, labels, wordForLabel } : null;
}
export function normalizeAlignmentAudio(samples: Float32Array) {
  let mean = 0;
  for (const value of samples) {
    if (!Number.isFinite(value)) throw new Error('Guide audio contains non-finite samples.');
    mean += value;
  }
  mean /= samples.length;
  let variance = 0;
  for (const value of samples) variance += (value - mean) ** 2;
  const scale = Math.sqrt(variance / samples.length + 1e-7);
  return Float32Array.from(samples, value => (value - mean) / scale);
}
export interface CtcTokenSpan { startFrame: number; endFrame: number; peakProbability: number }
/** Exact Viterbi CTC DP: blank/token states, stay/advance/skip, repeated-label restriction.
 * Each frame is consumed, including leading/trailing blanks. No transcription replacement.
 * Two score rows + one byte per frame/state; async yield permits cancellation in long loops.
 */
export async function forcedAlignCtc(logits: Float32Array, vocabularySize: number, labels: readonly number[], blank = 0, signal?: AbortSignal): Promise<CtcTokenSpan[] | null> {
  signal?.throwIfAborted();
  const frames = logits.length / vocabularySize;
  if (!Number.isInteger(frames) || vocabularySize < 2 || !Number.isInteger(vocabularySize) || labels.some(l => !Number.isInteger(l) || l < 0 || l >= vocabularySize || l === blank) || !Number.isInteger(blank) || blank < 0 || blank >= vocabularySize) throw new Error('Invalid CTC emissions or labels.');
  if (!labels.length || !frames) return null;
  if (labels.length > MAX_LABELS || frames > MAX_SECONDS * RATE / STRIDE) throw new Error('CTC alignment exceeds bounded line limits.');
  const needed = labels.length + labels.slice(1).filter((l, i) => l === labels[i]).length;
  if (frames < needed) return null;
  const states = labels.length * 2 + 1;
  const back = new Uint8Array(frames * states);
  let previous = new Float64Array(states).fill(-Infinity), current = new Float64Array(states);
  // A virtual blank before the first frame permits either initial state 0 or 1.
  previous[0] = 0;
  const logProb = new Float32Array(logits.length);
  for (let t = 0; t < frames; t++) {
    if (t % 64 === 0) { await yieldLoop(); signal?.throwIfAborted(); }
    const offset = t * vocabularySize;
    let max = -Infinity;
    for (let v = 0; v < vocabularySize; v++) {
      if (!Number.isFinite(logits[offset + v])) throw new Error('Alignment model produced non-finite emissions.');
      max = Math.max(max, logits[offset + v]);
    }
    let sum = 0;
    for (let v = 0; v < vocabularySize; v++) sum += Math.exp(logits[offset + v] - max);
    const normalizer = max + Math.log(sum);
    for (let v = 0; v < vocabularySize; v++) logProb[offset + v] = logits[offset + v] - normalizer;
    current.fill(-Infinity);
    for (let s = 0; s < states; s++) {
      const label = s % 2 ? labels[(s - 1) / 2] : blank;
      let score = previous[s], step = 0;
      if (s > 0 && previous[s - 1] > score) { score = previous[s - 1]; step = 1; }
      if (s > 1 && s % 2 && label !== labels[(s - 3) / 2] && previous[s - 2] > score) { score = previous[s - 2]; step = 2; }
      current[s] = score + logProb[offset + label];
      back[t * states + s] = step;
    }
    [previous, current] = [current, previous];
  }
  let state = previous[states - 1] > previous[states - 2] ? states - 1 : states - 2;
  if (!Number.isFinite(previous[state])) return null;
  const spans = labels.map(() => ({ startFrame: frames, endFrame: 0, peakProbability: 0 }));
  for (let t = frames - 1; t >= 0; t--) {
    if (state % 2) {
      const index = (state - 1) / 2, span = spans[index];
      span.startFrame = t; span.endFrame = Math.max(span.endFrame, t + 1);
      span.peakProbability = Math.max(span.peakProbability, Math.exp(logProb[t * vocabularySize + labels[index]]));
    }
    state -= back[t * states + state];
  }
  signal?.throwIfAborted();
  return spans.every(s => s.endFrame > s.startFrame) ? spans : null;
}

export interface AlignmentThresholds { minConfidence: number; minWordConfidence: number; minSupport: number }
export function scoreAlignment(spans: CtcTokenSpan[], wordForLabel: number[], words: number, thresholds: AlignmentThresholds) {
  const probabilities = Array.from({ length: words }, () => [] as number[]);
  spans.forEach((span, i) => { if (wordForLabel[i] >= 0) probabilities[wordForLabel[i]].push(span.peakProbability); });
  const geometric = (p: number[]) => p.length ? Math.exp(p.reduce((sum, value) => sum + Math.log(Math.max(1e-30, value)), 0) / p.length) : 0;
  const all = probabilities.flat();
  const confidence = geometric(all), wordConfidence = probabilities.map(geometric);
  const support = all.length ? all.filter(p => p >= 0.15).length / all.length : 0;
  return { confidence, wordConfidence, support, accepted: confidence >= thresholds.minConfidence && wordConfidence.every(p => p >= thresholds.minWordConfidence) && support >= thresholds.minSupport };
}

async function decodeSegment(audioPath: string, start: number, seconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', audioPath, '-t', String(seconds), '-map', '0:a:0', '-vn', '-ar', String(RATE), '-ac', '1', '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0, stderr = '', exceeded = false;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > Math.ceil(MAX_SECONDS * RATE) * 4) { exceeded = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const abort = () => { child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', error => { signal?.removeEventListener('abort', abort); reject(new Error(`Cannot start FFmpeg for alignment: ${error.message}. Check FFMPEG_PATH.`)); });
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason || new Error('Alignment canceled.'));
      else if (exceeded) reject(new Error('Decoded alignment segment exceeds memory limit.'));
      else if (code !== 0) reject(new Error(`FFmpeg alignment decode failed (${code}): ${stderr}`));
      else resolve(Buffer.concat(chunks));
    });
  });
  if (bytes.length % 4) throw new Error('Incomplete decoded guide PCM.');
  return Float32Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
}

async function emit(samples: Float32Array, runtime: Awaited<ReturnType<typeof createAlignmentSession>>, signal?: AbortSignal) {
  const frames = Math.floor((samples.length - RECEPTIVE) / STRIDE) + 1;
  if (frames <= 0) return new Float32Array();
  const logits = new Float32Array(frames * VOCAB_SIZE), covered = new Uint8Array(frames);
  const coreSamples = CHUNK_SECONDS * RATE;
  for (let core = 0; core < samples.length; core += coreSamples) {
    signal?.throwIfAborted();
    const first = Math.max(0, core - CONTEXT_SAMPLES), last = Math.min(samples.length, core + coreSamples + CONTEXT_SAMPLES);
    if (last - first < RECEPTIVE) continue;
    const input = new runtime.ort.Tensor('float32', normalizeAlignmentAudio(samples.subarray(first, last)), [1, last - first]);
    try {
      const result = await runtime.session.run({ input_values: input });
      try {
        signal?.throwIfAborted();
        const value = result.logits;
        const expected = Math.floor((last - first - RECEPTIVE) / STRIDE) + 1;
        if (value.type !== 'float32' || value.dims[0] !== 1 || value.dims[1] !== expected || value.dims[2] !== VOCAB_SIZE) throw new Error('Unexpected alignment emission dimensions or convolution stride.');
        const data = value.data as Float32Array;
        for (let t = 0; t < expected; t++) {
          const global = first / STRIDE + t, center = global * STRIDE + RECEPTIVE / 2;
          if (center < core || center >= core + coreSamples || global >= frames) continue;
          logits.set(data.subarray(t * VOCAB_SIZE, (t + 1) * VOCAB_SIZE), global * VOCAB_SIZE); covered[global] = 1;
        }
      } finally { for (const output of Object.values(result)) output.dispose(); }
    } finally { input.dispose(); }
  }
  if (covered.some(v => !v)) throw new Error('Alignment chunk emissions contain uncovered frames.');
  return logits;
}

export interface AlignmentMetadata {
  model: string; sha256: string; engine: 'ctc-viterbi'; version: 1; sampleRate: 16000;
  thresholds: AlignmentThresholds;
  lines: { index: number; accepted: boolean; confidence?: number; wordConfidence?: number[]; support?: number; reason?: string }[];
}
export type AlignedLyrics = Lyrics & { alignment: AlignmentMetadata };
export class NoAcceptedAlignmentError extends Error {
  constructor(public readonly diagnostics: AlignmentMetadata['lines']) {
    super('No lyric lines passed local alignment confidence checks. Check the selected lyrics, line timestamps, guide vocal quality and English language; original lyrics were preserved.');
    this.name = 'NoAcceptedAlignmentError';
  }
}

export async function alignLyrics(audioPath: string, lyrics: Lyrics, options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<Lyrics> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  if (!['line', 'word'].includes(lyrics.kind) || !lyrics.lines.length) throw new Error('Alignment requires existing timestamped lyric lines. Select synchronized lyrics first.');
  const thresholds: AlignmentThresholds = {
    minConfidence: setting('KARAOKE_ALIGNMENT_MIN_CONFIDENCE', 0.45, 0, 1),
    minWordConfidence: setting('KARAOKE_ALIGNMENT_MIN_WORD_CONFIDENCE', 0.25, 0, 1),
    minSupport: setting('KARAOKE_ALIGNMENT_MIN_SUPPORT', 0.8, 0, 1),
  };
  const context = setting('KARAOKE_ALIGNMENT_CONTEXT_SECONDS', 0.6, 0, 2);
  const file = await registeredModel(signal);
  signal?.throwIfAborted();
  const runtime = await createAlignmentSession(file);
  const diagnostics: AlignmentMetadata['lines'] = [];
  const lines = lyrics.lines.map(line => ({ ...line, ...(line.words ? { words: line.words.map(word => ({ ...word })) } : {}) }));
  let accepted = 0, previousWordEnd = 0;
  try {
    onProgress?.(0); signal?.throwIfAborted();
    for (let index = 0; index < lines.length; index++) {
      signal?.throwIfAborted();
      const line = lines[index], tokens = alignmentTokens(line.text);
      // Keep provider timings and previously accepted results when filling gaps.
      if (line.words?.length) {
        previousWordEnd = Math.max(previousWordEnd, line.words.at(-1)!.end ?? line.words.at(-1)!.start);
        diagnostics.push({ index, accepted: false, reason: 'existing word timings preserved' });
        onProgress?.((index + 1) / lines.length);
        continue;
      }
      const nextStart = lines[index + 1]?.start;
      const end = Math.min(line.end ?? nextStart ?? line.start + 12, nextStart ?? Infinity);
      const start = Math.max(0, line.start - context), windowEnd = end + context;
      let reason: string | undefined;
      if (!tokens) reason = 'unsupported or empty text';
      else if (!Number.isFinite(line.start) || line.start < 0 || !Number.isFinite(end) || end <= line.start || (index > 0 && line.start <= lines[index - 1].start)) reason = 'invalid or unordered line timestamps';
      else if (windowEnd - start > MAX_SECONDS) reason = 'line exceeds 24-second bound';
      if (reason || !tokens) { diagnostics.push({ index, accepted: false, reason }); }
      else {
        const samples = await decodeSegment(audioPath, start, windowEnd - start, signal);
        const logits = await emit(samples, runtime, signal);
        const spans = await forcedAlignCtc(logits, VOCAB_SIZE, tokens.labels, 0, signal);
        if (!spans) diagnostics.push({ index, accepted: false, reason: 'no CTC path' });
        else {
          const score = scoreAlignment(spans, tokens.wordForLabel, tokens.words.length, thresholds);
          const words: LyricWord[] = tokens.words.map(text => ({ text, start: Infinity, end: 0 }));
          spans.forEach((span, i) => {
            const word = words[tokens.wordForLabel[i]];
            if (!word) return; // Word delimiter is an acoustic label, not a display word.
            // Frame centers follow the actual valid convolution: RF=400, stride=320.
            word.start = Math.min(word.start, start + (span.startFrame * STRIDE + (RECEPTIVE - STRIDE) / 2) / RATE);
            word.end = Math.max(word.end!, Math.min(start + samples.length / RATE, start + (span.endFrame * STRIDE + (RECEPTIVE - STRIDE) / 2) / RATE));
          });
          const nextWordStart = lines[index + 1]?.words?.[0]?.start ?? nextStart;
          const overlap = words[0].start < previousWordEnd || (nextWordStart !== undefined && words.at(-1)!.end! > nextWordStart);
          if (score.accepted && !overlap) {
            line.words = words; accepted++; previousWordEnd = words.at(-1)!.end!;
            diagnostics.push({ index, accepted: true, confidence: score.confidence, wordConfidence: score.wordConfidence, support: score.support });
          } else diagnostics.push({ index, accepted: false, confidence: score.confidence, wordConfidence: score.wordConfidence, support: score.support, reason: overlap ? 'overlaps previous accepted line' : 'insufficient acoustic confidence' });
        }
      }
      onProgress?.((index + 1) / lines.length); signal?.throwIfAborted();
    }
    if (!accepted) throw new NoAcceptedAlignmentError(diagnostics);
    const result: AlignedLyrics = { ...lyrics, kind: 'word', lines, alignment: {
      model: ALIGNMENT_MODEL.id, sha256: ALIGNMENT_MODEL.files[0].sha256, engine: 'ctc-viterbi', version: 1, sampleRate: RATE, thresholds, lines: diagnostics,
    } };
    return result;
  } finally { await runtime.session.release(); }
}

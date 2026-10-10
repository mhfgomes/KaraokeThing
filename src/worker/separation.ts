import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';

export const SCNET = {
  id: 'audiojs/scnet@e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46',
  revision: 'e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46',
  url: 'https://huggingface.co/audiojs/scnet/resolve/e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46/scnet.int8.onnx',
  sha256: '98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845',
  bytes: 12900277,
};
const RATE = 44100;
const SEGMENT = 485100;
export function modelDirectory() { return path.join(path.resolve(process.env.KARAOKE_DATA_DIR || 'data'), 'models'); }
export async function sha256File(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function registeredModel() {
  const file = process.env.KARAOKE_SCNET_MODEL ? path.resolve(process.env.KARAOKE_SCNET_MODEL) : path.join(modelDirectory(), 'scnet', 'scnet.int8.onnx');
  const hash = process.env.KARAOKE_SCNET_MODEL ? process.env.KARAOKE_SCNET_SHA256 : SCNET.sha256;
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Manual SCNet model requires KARAOKE_SCNET_SHA256 (64 hex characters).');
  try { await stat(file); } catch { throw new Error(`SCNet model missing: ${file}. Run npx tsx scripts/install-model.ts.`); }
  if (await sha256File(file) !== hash.toLowerCase()) throw new Error(`SCNet checksum mismatch: ${file}. Reinstall the model.`);
  return { file, id: process.env.KARAOKE_SCNET_MODEL ? `manual-scnet@${hash.toLowerCase()}` : SCNET.id };
}
async function createSession(file: string) {
  const ort = await import('onnxruntime-node');
  const threads = Number(process.env.KARAOKE_INFERENCE_THREADS || 2);
  if (!Number.isInteger(threads) || threads < 1 || threads > 64) throw new Error('KARAOKE_INFERENCE_THREADS must be an integer from 1 to 64.');
  const session = await ort.InferenceSession.create(file, { executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1, enableCpuMemArena: false, enableMemPattern: false });
  const valid = (m: typeof session.inputMetadata, shape: number[]) => m.length === 1 && m[0].isTensor && m[0].type === 'float32' && JSON.stringify(m[0].shape) === JSON.stringify(shape);
  if (!valid(session.inputMetadata, [1, 4, 2049, 476]) || !valid(session.outputMetadata, [1, 16, 2049, 476])) {
    await session.release();
    throw new Error('Incompatible SCNet graph: expected float32 [1,4,2049,476] → [1,16,2049,476], source order drums/bass/other/vocals.');
  }
  return { ort, session };
}
export async function modelStatus(): Promise<{ ready: boolean; error: string | null }> {
  try {
    const model = await registeredModel();
    const { session } = await createSession(model.file);
    await session.release();
    await import('@audio/neural-separate');
    return { ready: true, error: null };
  } catch (error) { return { ready: false, error: error instanceof Error ? error.message : String(error) }; }
}
function check(signal: AbortSignal) { signal.throwIfAborted(); }
async function ffmpeg(args: string[], signal: AbortSignal) {
  check(signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    const abort = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    // Cover an abort between the preflight check and listener registration.
    if (signal.aborted) abort();
    child.on('error', reject);
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason || new Error('Separation canceled'));
      else if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (${code}): ${stderr || 'check FFMPEG_PATH and audio input'}`));
    });
  });
}
async function readFrames(file: FileHandle, first: number, count: number) {
  const bytes = Buffer.alloc(count * 8);
  let done = 0;
  while (done < bytes.length) {
    const { bytesRead } = await file.read(bytes, done, bytes.length - done, first * 8 + done);
    if (!bytesRead) throw new Error('Unexpected end of decoded PCM.');
    done += bytesRead;
  }
  return bytes;
}
function reflect(i: number, length: number) {
  if (length <= 1) return 0;
  const period = 2 * (length - 1);
  const k = ((i % period) + period) % period;
  return k < length ? k : period - k;
}
// Exported for focused DSP regression tests. Population is the stereo mono mix;
// the sample deviation and epsilon match neural-separate's SCNet normalization.
export function pcmStatistics(bytes: Buffer, state = { count: 0, mean: 0, m2: 0 }) {
  for (let i = 0; i < bytes.length; i += 8) {
    const value = (bytes.readFloatLE(i) + bytes.readFloatLE(i + 4)) / 2;
    if (!Number.isFinite(value)) throw new Error('Input contains non-finite PCM samples.');
    state.count++;
    const delta = value - state.mean;
    state.mean += delta / state.count;
    state.m2 += delta * (value - state.mean);
  }
  return state;
}
export function overlapWeight(i: number, length: number, first: boolean, last: boolean) {
  const fade = Math.floor(length * 0.1);
  return Math.min(1, first ? 1 : i / (fade - 1), last ? 1 : (length - 1 - i) / (fade - 1));
}
export async function separateAudio(inputPath: string, outputDir: string, options: {
  quality: 'balanced' | 'high'; signal: AbortSignal; onProgress: (fraction: number) => void;
}): Promise<{ backing: string; guide: string; model: string }> {
  const { signal, onProgress } = options;
  check(signal);
  if (!['balanced', 'high'].includes(options.quality)) throw new Error('Unknown separation quality.');
  const model = await registeredModel();
  check(signal);
  await mkdir(outputDir, { recursive: true });
  const work = await mkdtemp(path.join(outputDir, '.separation-'));
  let runtime: Awaited<ReturnType<typeof createSession>> | undefined;
  const handles: FileHandle[] = [];
  try {
    onProgress(0);
    const pcm = path.join(work, 'input.f32');
    await ffmpeg(['-i', inputPath, '-map', '0:a:0', '-vn', '-ar', String(RATE), '-ac', '2', '-f', 'f32le', pcm], signal);
    const size = (await stat(pcm)).size;
    if (!size || size % 8) throw new Error('Decoded audio is empty or has incomplete stereo frames.');
    const frames = size / 8;
    const input = await open(pcm, 'r'); handles.push(input);
    const stats = { count: 0, mean: 0, m2: 0 };
    for (let s = 0; s < frames; s += SEGMENT) {
      check(signal); pcmStatistics(await readFrames(input, s, Math.min(SEGMENT, frames - s)), stats);
    }
    const std = Math.sqrt(stats.m2 / Math.max(1, frames - 1)) + 1e-8;
    onProgress(0.05);
    runtime = await createSession(model.file);
    check(signal);
    const { default: separate } = await import('@audio/neural-separate');
    const { ort, session } = runtime;
    const adapter = {
      inputs: [{ name: session.inputNames[0], dims: [1, 4, 2049, 476] }],
      outputs: [{ name: session.outputNames[0] }],
      async run(feeds: Record<string, { data: Float32Array; dims: number[] }>) {
        check(signal);
        const tensors = Object.fromEntries(Object.entries(feeds).map(([name, value]) => [name, new ort.Tensor('float32', value.data, value.dims)]));
        try {
          const result = await session.run(tensors);
          try {
            check(signal);
            const value = result[session.outputNames[0]];
            if (value.type !== 'float32' || value.data.length !== 16 * 2049 * 476) throw new Error('Invalid SCNet output.');
            return { [session.outputNames[0]]: { data: Float32Array.from(value.data as Float32Array), dims: [...value.dims] } };
          } finally { for (const value of Object.values(result)) value.dispose(); }
        } finally { for (const value of Object.values(tensors)) value.dispose(); }
      },
    };
    const guideRaw = path.join(work, 'guide.f32'), backingRaw = path.join(work, 'backing.f32');
    const guideFile = await open(guideRaw, 'w'), backingFile = await open(backingRaw, 'w');
    handles.push(guideFile, backingFile);
    const step = Math.floor(SEGMENT * (options.quality === 'high' ? 0.25 : 0.5));
    const border = frames > 2 * (SEGMENT - step) ? SEGMENT - step : 0;
    const total = frames + 2 * border;
    const chunks = Math.max(1, Math.ceil((total - SEGMENT) / step) + 1);
    const accum = [new Float64Array(SEGMENT), new Float64Array(SEGMENT)];
    const weights = new Float64Array(SEGMENT);
    let peak = 0;
    for (let k = 0; k < chunks; k++) {
      check(signal);
      const start = k * step, len = Math.min(SEGMENT, total - start), last = k === chunks - 1;
      const indices = new Float64Array(SEGMENT).fill(-1);
      let low = frames, high = -1;
      for (let i = 0; i < SEGMENT; i++) {
        if (i >= len && len <= SEGMENT / 2) continue;
        const virtual = start + (i < len ? i : reflect(i, len)) - border;
        const index = reflect(virtual, frames);
        indices[i] = index; low = Math.min(low, index); high = Math.max(high, index);
      }
      const bytes = await readFrames(input, low, high - low + 1);
      const channels = [new Float32Array(SEGMENT), new Float32Array(SEGMENT)];
      for (let i = 0; i < SEGMENT; i++) if (indices[i] >= 0) for (let c = 0; c < 2; c++) channels[c][i] = (bytes.readFloatLE((indices[i] - low) * 8 + c * 4) - stats.mean) / std;
      const { stems } = await separate(channels, {
        sampleRate: RATE, model: { url: model.file, targets: ['drums', 'bass', 'other', 'vocals'] }, targets: ['vocals'],
        modelType: 'complex', n: 4096, hop: 1024, window: 'ones', normalized: true,
        segment: SEGMENT, frames: 476, step: 1, standardize: false, session: () => adapter,
      });
      check(signal);
      for (let i = 0; i < len; i++) {
        const weight = overlapWeight(i, SEGMENT, k === 0, last);
        weights[i] += weight;
        for (let c = 0; c < 2; c++) {
          const value = stems.vocals[c][i] * std;
          if (!Number.isFinite(value)) throw new Error('SCNet produced non-finite audio.');
          accum[c][i] += value * weight;
        }
      }
      const flush = last ? len : step;
      const first = Math.max(0, border - start), end = Math.min(flush, frames + border - start);
      if (end > first) {
        const source = await readFrames(input, start + first - border, end - first);
        const vocals = Buffer.alloc(source.length), backing = Buffer.alloc(source.length);
        for (let i = first; i < end; i++) for (let c = 0; c < 2; c++) {
          if (!(weights[i] > 0)) throw new Error('Uncovered overlap sample.');
          const v = accum[c][i] / weights[i], offset = (i - first) * 8 + c * 4;
          const b = source.readFloatLE(offset) - v;
          peak = Math.max(peak, Math.abs(v), Math.abs(b));
          vocals.writeFloatLE(v, offset); backing.writeFloatLE(b, offset);
        }
        await guideFile.writeFile(vocals); await backingFile.writeFile(backing);
      }
      for (const a of [...accum, weights]) { a.copyWithin(0, flush); a.fill(0, SEGMENT - flush); }
      onProgress(0.05 + 0.85 * (k + 1) / chunks);
    }
    await guideFile.close(); await backingFile.close();
    // One shared gain preserves the mixture relationship and avoids independent normalization.
    const gain = peak > 0.95 ? 0.95 / peak : 1;
    for (const [name, source] of [['guide', guideRaw], ['backing', backingRaw]]) {
      await ffmpeg(['-f', 'f32le', '-ar', String(RATE), '-ac', '2', '-i', source, '-af', `volume=${gain}`, '-c:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '1', path.join(work, `${name}.mp3`)], signal);
    }
    check(signal);
    // Publish a unique directory with both stems in a single rename.
    const finished = path.join(outputDir, `${path.basename(work).slice(1)}-stems`);
    for (const handle of handles) await handle.close().catch(() => {});
    await rm(pcm); await rm(guideRaw); await rm(backingRaw);
    await rename(work, finished);
    onProgress(1);
    return { backing: path.join(finished, 'backing.mp3'), guide: path.join(finished, 'guide.mp3'), model: model.id };
  } finally {
    for (const handle of handles) await handle.close().catch(() => {});
    try { await runtime?.session.release(); } finally { await rm(work, { recursive: true, force: true }); }
  }
}

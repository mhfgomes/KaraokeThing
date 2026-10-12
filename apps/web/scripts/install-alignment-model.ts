import { mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALIGNMENT_MODEL, alignmentModelDirectory, alignmentModelStatus, alignmentSha256, createAlignmentSession } from '../src/worker/alignment';

/** Download only pinned ready-to-run artifacts; no Python/export/Transformers dependency. */
export async function installAlignmentModel(options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}) {
  options.signal?.throwIfAborted();
  const target = alignmentModelDirectory(), parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const work = await mkdtemp(path.join(parent, '.alignment-install-'));
  const total = ALIGNMENT_MODEL.files.reduce((sum, file) => sum + file.bytes, 0);
  let received = 0;
  try {
    options.onProgress?.(0);
    for (const artifact of ALIGNMENT_MODEL.files) {
      options.signal?.throwIfAborted();
      const response = await fetch(artifact.url, { signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) throw new Error(`Alignment download failed (${artifact.name}): HTTP ${response.status}. Retry installation when online.`);
      const file = path.join(work, artifact.name), output = await open(file, 'wx');
      const reader = response.body.getReader();
      let bytes = 0;
      try {
        while (true) {
          options.signal?.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length; received += value.length;
          if (bytes > artifact.bytes) throw new Error(`Alignment download exceeded pinned size (${artifact.name}).`);
          await output.writeFile(value);
          options.onProgress?.(received / total);
        }
      } finally { await reader.cancel().catch(() => {}); await output.close(); }
      if (bytes !== artifact.bytes || await alignmentSha256(file, options.signal) !== artifact.sha256) throw new Error(`Alignment SHA-256/size verification failed (${artifact.name}). Existing installation retained.`);
    }
    options.signal?.throwIfAborted();
    const { session } = await createAlignmentSession(path.join(work, ALIGNMENT_MODEL.files[0].name));
    await session.release();
    await writeFile(path.join(work, 'artifact.json'), JSON.stringify({ ...ALIGNMENT_MODEL, installedAt: new Date().toISOString(), exporter: 'Xenova', authors: 'Alexei Baevski, Henry Zhou, Abdelrahman Mohamed, Michael Auli / Meta' }, null, 2) + '\n');
    options.signal?.throwIfAborted();
    // Directory swap with rollback supports Windows, which cannot rename over existing files.
    // Install while the worker is stopped; running sessions may lock model files on Windows.
    const backup = `${work}-previous`;
    let old = false;
    try { await rename(target, backup); old = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(work, target); }
    catch (error) { if (old) await rename(backup, target); throw error; }
    if (old) await rm(backup, { recursive: true, force: true });
    return path.join(target, ALIGNMENT_MODEL.files[0].name);
  } finally { await rm(work, { recursive: true, force: true }); }
}

async function main() {
  if (process.argv.includes('--check')) {
    const status = await alignmentModelStatus(); console.log(JSON.stringify(status));
    if (!status.ready) process.exitCode = 1;
    return;
  }
  console.log(`Downloading ${ALIGNMENT_MODEL.id} (Apache-2.0 upstream weights, 95.3 MB quantized ONNX).`);
  console.log(`Installed: ${await installAlignmentModel()}`);
  console.log('Pinned file checksums and native CPU graph loading verified.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

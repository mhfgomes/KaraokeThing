import { mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCNET, modelDirectory, modelStatus, sha256File } from '../src/worker/separation';

/** Downloads a published model; never trains, exports, or invokes Python. */
export async function installModel() {
  const root = modelDirectory();
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(path.join(root, '.scnet-install-'));
  const target = path.join(root, 'scnet');
  try {
    const file = path.join(work, 'scnet.int8.onnx');
    const response = await fetch(SCNET.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
    const output = await open(file, 'wx');
    let bytes = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        bytes += chunk.length;
        if (bytes > SCNET.bytes) throw new Error('Model download exceeded its pinned size.');
        await output.writeFile(chunk);
      }
    } finally { await output.close(); }
    if (bytes !== SCNET.bytes || await sha256File(file) !== SCNET.sha256) throw new Error('Model size/SHA-256 verification failed. No model was installed.');
    for (const name of ['LICENSE', 'README.md']) {
      const source = `https://huggingface.co/audiojs/scnet/resolve/${SCNET.revision}/${name}`;
      const notice = await fetch(source, { signal: AbortSignal.timeout(30_000) });
      if (!notice.ok) throw new Error(`Cannot download model attribution ${name}: HTTP ${notice.status}`);
      const body = await notice.text();
      if (body.length > 100_000) throw new Error('Unexpectedly large model notice.');
      await writeFile(path.join(work, name), body);
    }
    await writeFile(path.join(work, 'artifact.json'), JSON.stringify({ ...SCNET, license: 'MIT', author: 'starrytong / SCNet authors', exporter: 'audiojs', installedAt: new Date().toISOString() }, null, 2) + '\n');
    // Existing installations are retained on failed downloads. Replace only after verification.
    await mkdir(target, { recursive: true });
    for (const name of ['LICENSE', 'README.md', 'artifact.json', 'scnet.int8.onnx']) await rename(path.join(work, name), path.join(target, name));
    return path.join(target, 'scnet.int8.onnx');
  } finally { await rm(work, { recursive: true, force: true }); }
}
async function main() {
  if (process.argv.includes('--check')) {
    const status = await modelStatus();
    console.log(JSON.stringify(status));
    if (!status.ready) process.exitCode = 1;
  } else {
    console.log(`Downloading ${SCNET.id} (MIT weights; 12.9 MB).`);
    console.log(`Installed: ${await installModel()}`);
    const status = await modelStatus();
    if (!status.ready) throw new Error(status.error || 'Model could not load');
    console.log('Model checksum and Node CPU graph loading verified.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}

import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// In the monorepo, Next nests the traced server under apps/web; keep the worker and tools beside it.
const output = '.next/standalone/apps/web';

// Next traces the web server. Bundle the separate worker and CLI tools as well,
// leaving only ONNX's native addon external to the JavaScript bundles.
await build({
  entryPoints: {
    worker: 'src/worker/index.ts',
    'scripts/launch': 'scripts/launch.ts',
    'scripts/install-model': 'scripts/install-model.ts',
    'scripts/install-alignment-model': 'scripts/install-alignment-model.ts',
  },
  outdir: output,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['onnxruntime-node'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'eof',
});

async function packageDirectory(name) {
  let directory = path.dirname(require.resolve(name, {
    paths: [path.dirname(require.resolve('onnxruntime-node'))],
  }));
  while (directory !== path.dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) return directory;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot locate package directory: ${name}`);
}

for (const name of ['onnxruntime-node', 'onnxruntime-common']) {
  const source = await packageDirectory(name);
  const target = path.join(output, 'node_modules', name);
  await rm(target, { recursive: true, force: true });
  await cp(await realpath(source), target, { recursive: true, dereference: true });
}

// The npm package includes macOS, Windows and both Linux architectures.
// Retain only the platform/architecture of this build, without CPU/GPU changes.
const nativeRoot = path.join(output, 'node_modules/onnxruntime-node/bin/napi-v6');
for (const platform of await readdir(nativeRoot)) {
  const directory = path.join(nativeRoot, platform);
  if (platform !== process.platform) await rm(directory, { recursive: true });
  else for (const arch of await readdir(directory)) {
    if (arch !== process.arch) await rm(path.join(directory, arch), { recursive: true });
  }
}

await mkdir(path.join(output, 'licenses'), { recursive: true });
await cp('node_modules/@audio/neural-separate/NOTICE', path.join(output, 'licenses/neural-separate-NOTICE'));
await cp('../../LICENSE', path.join(output, 'LICENSE'));
await rm(path.join(output, '.next/cache'), { recursive: true, force: true });

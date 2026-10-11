import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, open, readFile, rm } from 'node:fs/promises';

const mode = process.argv.includes('--production') ? 'start' : 'dev';
const standalone = process.argv.includes('--standalone');
if (standalone && mode !== 'start') throw new Error('Standalone output requires production mode.');
const cwd = fileURLToPath(new URL('../', import.meta.url));
const dataDir = path.resolve(process.env.KARAOKE_DATA_DIR || path.join(cwd, 'data'));
await mkdir(dataDir, { recursive: true });
const lock = path.join(dataDir, 'app.lock');
try {
  const oldPid = Number(await readFile(lock, 'utf8'));
  try { process.kill(oldPid, 0); throw new Error(`The app is already running (PID ${oldPid}).`); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
  await rm(lock, { force: true });
} catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
const file = await open(lock, 'wx'); await file.writeFile(String(process.pid)); await file.close();
const host = process.env.KARAOKE_HOST || '0.0.0.0';
const port = process.env.PORT || '3100';
const env = { ...process.env, KARAOKE_DATA_DIR: dataDir, ...(standalone ? { HOSTNAME: host, PORT: port } : {}) };
const args = standalone ? [path.join(cwd, 'server.js')] : [path.join(cwd, 'node_modules/next/dist/bin/next'), mode, '--hostname', host, '--port', port];
if (process.env.KARAOKE_HTTPS === '1' && mode === 'dev') args.push('--experimental-https');
const server = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
const worker = spawn(process.execPath, standalone ? ['worker.mjs'] : ['--import', 'tsx', 'src/worker/index.ts'], { cwd, env, stdio: 'inherit' });
console.info(`\nKaraokeThing: http${process.env.KARAOKE_HTTPS === '1' && mode === 'dev' ? 's' : ''}://localhost:${port}`);
for (const entries of Object.values(networkInterfaces())) for (const address of entries || []) {
  if (address.family === 'IPv4' && !address.internal) console.info(`Home network: http://${address.address}:${port} (use trusted HTTPS for browser microphones on other devices)`);
}
let closing = false;
async function close(code: number) {
  if (closing) return;
  closing = true;
  server.kill('SIGTERM'); worker.kill('SIGTERM');
  const grace = setTimeout(() => { server.kill('SIGKILL'); worker.kill('SIGKILL'); }, 15000);
  await Promise.all([server, worker].map(child => child.exitCode !== null || child.signalCode ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()))));
  clearTimeout(grace); await rm(lock, { force: true }); process.exitCode = code;
}
server.on('exit', code => { void close(code ?? 1); });
worker.on('exit', code => { if (!closing) { console.error('Preparation worker stopped; shutting down the app.'); void close(code ?? 1); } });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void close(0); });

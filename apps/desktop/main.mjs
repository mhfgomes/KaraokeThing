// KaraokeThing Stage: a full-screen window onto the host's /stage page.
// It only shows lyrics and plays sound; the host's admin panel controls everything.
import { app, BrowserWindow, Menu, ipcMain, net, powerSaveBlocker, screen, session, systemPreferences } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = (name) => path.join(here, 'pages', name);
const configFile = path.join(app.getPath('userData'), 'config.json');
const RETRY_MS = 3000;

/** A stage link looks like http://host:3100/stage#key=…; keep only what we need from it. */
function parseLink(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const key = new URLSearchParams(url.hash.slice(1)).get('key');
  return key ? { origin: url.origin, key } : null;
}
function readConfig() {
  try { return parseLink(JSON.parse(readFileSync(configFile, 'utf8')).link); } catch { return null; }
}
function writeConfig(link) {
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ link: `${link.origin}/stage#key=${encodeURIComponent(link.key)}` }, null, 2));
}

// `--stage-url=<link>` pairs from the command line, e.g. for an unattended TV computer.
const cliLink = parseLink(process.argv.find((a) => a.startsWith('--stage-url='))?.slice('--stage-url='.length));
if (cliLink) writeConfig(cliLink);
const config = readConfig();

// Play as soon as the host presses Start; nobody is at this screen to click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Browsers only allow microphones on secure pages, and the host on the home network is usually plain http.
if (config?.origin.startsWith('http:')) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', config.origin);

if (!app.requestSingleInstanceLock()) app.quit();

/** @type {BrowserWindow | null} */
let win = null;
let retry = null;

const stageUrl = () => `${config.origin}/stage#key=${encodeURIComponent(config.key)}`;

function showStage() {
  clearTimeout(retry);
  if (!config) { void win.loadFile(page('setup.html')); return; }
  void win.loadURL(stageUrl()).catch(() => undefined);
}

function createWindow() {
  win = new BrowserWindow({
    title: 'KaraokeThing Stage',
    backgroundColor: '#160f29',
    fullscreen: true,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  const wc = win.webContents;
  // Host unreachable: show a holding screen and keep trying until it's back.
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !config || !url.startsWith(config.origin)) return;
    void win.loadFile(page('offline.html'), { query: { host: config.origin } });
    clearTimeout(retry);
    retry = setTimeout(showStage, RETRY_MS);
  });
  wc.on('will-navigate', (e, url) => {
    if (url.startsWith('file:') || (config && url.startsWith(config.origin + '/'))) return;
    e.preventDefault();
  });
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  showStage();
}

function moveToNextDisplay() {
  const displays = screen.getAllDisplays();
  if (!win || displays.length < 2) return;
  const current = screen.getDisplayMatching(win.getBounds());
  const next = displays[(displays.findIndex((d) => d.id === current.id) + 1) % displays.length];
  const wasFull = win.isFullScreen();
  // Leave full screen first, or the window stays on the old display.
  const move = () => { win.setBounds(next.workArea); if (wasFull) win.setFullScreen(true); };
  if (wasFull) { win.once('leave-full-screen', move); win.setFullScreen(false); } else move();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Stage',
      submenu: [
        { label: 'Full Screen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11', click: () => win?.setFullScreen(!win.isFullScreen()) },
        { label: 'Move to Next Display', accelerator: 'CmdOrCtrl+Shift+D', click: moveToNextDisplay },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: showStage },
        { type: 'separator' },
        { label: 'Change Host Link…', accelerator: 'CmdOrCtrl+Shift+L', click: () => { clearTimeout(retry); void win?.loadFile(page('setup.html')); } },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
  ]));
}

const fromSetupPage = (event) => event.senderFrame?.url.startsWith('file:');

ipcMain.handle('stage:current', (event) => (fromSetupPage(event) && config ? stageUrl() : ''));
ipcMain.handle('stage:save', async (event, raw) => {
  if (!fromSetupPage(event)) return { error: 'Not allowed.' };
  const link = parseLink(raw);
  if (!link) return { error: 'That doesn’t look like a stage link. Copy it from the host’s Stage tab; it ends with #key=…' };
  try {
    const res = await net.fetch(`${link.origin}/api/state?limit=1`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`The host answered with status ${res.status}.`);
  } catch (e) {
    return { error: `Can’t reach ${link.origin}. Check the host is running and this computer is on the same network. (${e instanceof Error ? e.message : e})` };
  }
  writeConfig(link);
  // The microphone permission switch is read at startup, so restart with the new host.
  app.relaunch();
  app.exit(0);
  return {};
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  const allowed = new Set(['media', 'fullscreen', 'speaker-selection']);
  const ours = (url) => { try { return !!config && new URL(url).origin === config.origin; } catch { return false; } };
  // Microphones (audio only) for the host's page, nothing for anyone else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const ok = ours(details.requestingUrl) && allowed.has(permission) && !(details.mediaTypes ?? []).includes('video');
    // macOS asks the user once, the first time the host turns a microphone on.
    if (ok && permission === 'media' && process.platform === 'darwin') {
      systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
    } else callback(ok);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => ours(origin) && allowed.has(permission));
  powerSaveBlocker.start('prevent-display-sleep');
  buildMenu();
  createWindow();
});

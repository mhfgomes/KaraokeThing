'use client';

import { useRef, useState } from 'react';
import { FolderInput, KeyRound, Upload } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { authAction, formatBytes, importFolder, uploadOne, type IngestResult, type Quality } from '@/lib/client-api';
import { ErrorNote } from './ui-bits';

const EXT = ['.mp3', '.wav', '.flac', '.m4a', '.ogg'];
const MAX = 250 * 1024 * 1024;

interface Item { id: number; name: string; size: number; state: 'waiting' | 'uploading' | 'done' | 'duplicate' | 'error'; progress: number; message?: string }

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export function AdminPanel({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const [quality, setQuality] = useState<Quality>('balanced');
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const running = useRef(false);
  const [busyUploading, setBusyUploading] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const pending = useRef<{ item: Item; file: File; quality: Quality }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const [path, setPath] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<IngestResult | null>(null);
  const [importErr, setImportErr] = useState('');

  const [pw, setPw] = useState({ cur: '', next: '' });
  const [pwMsg, setPwMsg] = useState<{ ok?: string; err?: string }>({});

  const patchItem = (id: number, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const start = async (files: File[]) => {
    // Quality is fixed per file when it is added, even if the selector changes mid-upload.
    const fresh: { item: Item; file: File; quality: Quality }[] = files.map((file) => {
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      const item: Item = { id: nextId.current++, name: file.name, size: file.size, state: 'waiting', progress: 0 };
      if (!EXT.includes(ext)) { item.state = 'error'; item.message = 'Unsupported format. Use MP3, WAV, FLAC, M4A, or OGG.'; }
      else if (file.size > MAX) { item.state = 'error'; item.message = 'Larger than the 250 MB limit.'; }
      return { item, file, quality };
    });
    setItems((xs) => [...xs, ...fresh.map((f) => f.item)]);
    if (running.current) { pending.current.push(...fresh.filter((f) => f.item.state === 'waiting')); return; }
    pending.current.push(...fresh.filter((f) => f.item.state === 'waiting'));
    running.current = true;
    setBusyUploading(true);
    abort.current = new AbortController();
    while (pending.current.length) {
      const { item, file, quality } = pending.current.shift()!;
      patchItem(item.id, { state: 'uploading' });
      try {
        const r = await uploadOne(file, quality, (f) => patchItem(item.id, { progress: f }), abort.current.signal);
        if (r.errors.length) patchItem(item.id, { state: 'error', message: r.errors.join(' '), progress: 1 });
        else if (r.duplicates > 0 && r.added === 0) patchItem(item.id, { state: 'duplicate', message: 'Already in the library.', progress: 1 });
        else patchItem(item.id, { state: 'done', progress: 1 });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') { patchItem(item.id, { state: 'error', message: 'Canceled.' }); break; }
        patchItem(item.id, { state: 'error', message: msg(e) });
      }
      onChanged();
    }
    for (const p of pending.current) patchItem(p.item.id, { state: 'error', message: 'Canceled.' });
    pending.current = [];
    running.current = false;
    setBusyUploading(false);
  };

  const doImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setImportBusy(true); setImportErr(''); setImportResult(null);
    try { setImportResult(await importFolder(path.trim(), quality)); onChanged(); } catch (err) { setImportErr(msg(err)); }
    setImportBusy(false);
  };

  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg({});
    try { await authAction('password', pw.cur, pw.next); setPwMsg({ ok: 'Password changed.' }); setPw({ cur: '', next: '' }); } catch (err) { setPwMsg({ err: msg(err) }); }
  };

  const w = state.worker;
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
      {(!w.online || w.modelError || !w.modelReady) && (
        <ErrorNote tone="warn">
          {!w.online ? 'The background worker is offline, so songs will wait in line until it starts. Start the app with the project launcher so the worker runs too.'
            : w.modelError ? `The separation model is not ready: ${w.modelError}`
            : 'The separation model is still being prepared. Uploads are kept and will start when it is ready.'}
        </ErrorNote>
      )}

      <section aria-labelledby="ad-up" className="space-y-2">
        <h3 id="ad-up" className="font-display text-xl font-bold">Upload songs</h3>
        <div>
          <label className="lbl" htmlFor="ad-quality">Separation quality for new songs</label>
          <select id="ad-quality" className="field" value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
            <option value="balanced">Balanced (default)</option>
            <option value="high">Higher quality (slower)</option>
          </select>
        </div>
        <div
          className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${dragging ? 'border-gold bg-gold/10' : 'border-white/25'}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); void start(Array.from(e.dataTransfer.files)); }}
        >
          <Upload className="mx-auto mb-2 text-violet-soft" aria-hidden />
          <p className="text-sm">Drop MP3, WAV, FLAC, M4A, or OGG files here</p>
          <input ref={inputRef} type="file" multiple accept=".mp3,.wav,.flac,.m4a,.ogg,audio/*" className="sr-only" id="ad-files" onChange={(e) => { void start(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <button className="btn btn-primary mt-3" onClick={() => inputRef.current?.click()}>Choose files</button>
        </div>
        {items.length > 0 && (
          <>
            <ul className="space-y-1.5" aria-label="Uploads">
              {items.slice(-12).map((it) => (
                <li key={it.id} className="rounded-lg bg-black/20 p-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">{it.name}</span>
                    <span className={`shrink-0 text-xs font-bold ${it.state === 'error' ? 'text-[#ff8da6]' : it.state === 'done' ? 'text-mint' : 'text-muted-foreground'}`}>
                      {it.state === 'waiting' ? 'Waiting' : it.state === 'uploading' ? `${Math.round(it.progress * 100)}%` : it.state === 'done' ? 'Uploaded' : it.state === 'duplicate' ? 'Duplicate' : 'Failed'}
                    </span>
                  </div>
                  {it.state === 'uploading' && <div className="meter mt-1" role="progressbar" aria-label={`Uploading ${it.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(it.progress * 100)}><i style={{ width: `${it.progress * 100}%` }} /></div>}
                  {it.message && <p className={`mt-0.5 text-xs ${it.state === 'error' ? 'text-[#ffb0c0]' : 'text-muted-foreground'}`}>{it.message}</p>}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              {busyUploading && <button className="btn btn-sm" onClick={() => abort.current?.abort()}>Cancel remaining</button>}
              <button className="btn btn-sm btn-ghost" onClick={() => setItems((xs) => xs.filter((x) => x.state === 'uploading' || x.state === 'waiting'))}>Clear finished</button>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="ad-imp" className="space-y-2 border-t border-white/10 pt-4">
        <h3 id="ad-imp" className="font-display text-xl font-bold">Import a folder on this computer</h3>
        {state.importRoots.length === 0 ? (
          <p className="text-sm text-muted-foreground">Folder import is not set up. Set KARAOKE_IMPORT_ROOTS to one or more allowed folders and restart the app. Browser uploads work without it.</p>
        ) : (
          <form onSubmit={doImport} className="space-y-2">
            <p className="text-xs text-muted-foreground">Allowed folders (including subfolders):</p>
            <div className="flex flex-wrap gap-1.5">
              {state.importRoots.map((r) => <button type="button" key={r} className="btn btn-sm max-w-full" onClick={() => setPath(r)}><FolderInput size={13} /><span className="truncate">{r}</span></button>)}
            </div>
            <label className="lbl" htmlFor="ad-path">Folder path</label>
            <input id="ad-path" className="field" value={path} onChange={(e) => setPath(e.target.value)} placeholder={state.importRoots[0]} spellCheck={false} />
            <button className="btn btn-violet" disabled={!path.trim() || importBusy}>{importBusy ? 'Importing…' : 'Import folder'}</button>
          </form>
        )}
        {importErr && <ErrorNote>{importErr}</ErrorNote>}
        {importResult && (
          <div role="status" className="space-y-1 text-sm">
            <p>Added {importResult.added}, skipped {importResult.duplicates} duplicate{importResult.duplicates === 1 ? '' : 's'}{importResult.errors.length ? `, ${importResult.errors.length} problem${importResult.errors.length === 1 ? '' : 's'}` : ''}.</p>
            {importResult.errors.length > 0 && <ErrorNote><ul className="list-disc pl-4">{importResult.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}</ul>{importResult.errors.length > 8 && `…and ${importResult.errors.length - 8} more`}</ErrorNote>}
          </div>
        )}
      </section>

      <section aria-labelledby="ad-set" className="space-y-2 border-t border-white/10 pt-4">
        <h3 id="ad-set" className="font-display text-xl font-bold">Host settings</h3>
        <p className="text-sm text-muted-foreground">Library storage: {formatBytes(state.storageBytes)}. Worker: {w.online ? (w.processing ? 'busy preparing a song' : 'idle') : 'offline'}.</p>
        <form onSubmit={changePw} className="space-y-2">
          <div><label className="lbl" htmlFor="pw-cur">Current password</label><input id="pw-cur" type="password" className="field" autoComplete="current-password" value={pw.cur} onChange={(e) => setPw({ ...pw, cur: e.target.value })} /></div>
          <div><label className="lbl" htmlFor="pw-new">New password</label><input id="pw-new" type="password" className="field" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
          <button className="btn btn-sm" disabled={!pw.cur || !pw.next}><KeyRound size={13} /> Change password</button>
          {pwMsg.ok && <p role="status" className="text-sm text-mint">{pwMsg.ok}</p>}
          {pwMsg.err && <ErrorNote>{pwMsg.err}</ErrorNote>}
        </form>
      </section>
    </div>
  );
}

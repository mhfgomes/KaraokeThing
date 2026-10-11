'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { AppState, LyricMatch, Track } from '@/lib/types';
import {
  deleteTrack, fetchState, formatBytes, formatTime, lookupLyric, lyricMatches, patchTrack, prepareTrack, selectLyric, queueAdd, alignTrackLyrics, type Quality,
} from '@/lib/client-api';
import { ErrorNote, LyricsChip, Modal, StatusChip } from './ui-bits';

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export function AddToQueueDialog({ track, singers, onClose, onAdded }: { track: Track | null; singers: string[]; onClose: () => void; onAdded: (t: Track, singer: string) => void }) {
  return (
    <Modal open={!!track} onClose={onClose} title="Add to queue">
      {track && <AddBody key={track.id} track={track} singers={singers} onClose={onClose} onAdded={onAdded} />}
    </Modal>
  );
}

function AddBody({ track, singers, onClose, onAdded }: { track: Track; singers: string[]; onClose: () => void; onAdded: (t: Track, singer: string) => void }) {
  const [singer, setSinger] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = singer.trim();
    if (!name) { setError('Enter the singer’s name.'); return; }
    setBusy(true);
    setError('');
    try {
      await queueAdd(track.id, name);
      onAdded(track, name);
      onClose();
    } catch (err) { setError(msg(err)); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <p><span className="font-bold">{track.title}</span> <span className="text-muted-foreground">by {track.artist}</span></p>
      <div>
        <label className="lbl" htmlFor="singer-name">Singer name</label>
        <input id="singer-name" className="field" aria-invalid={!!error} aria-describedby={error ? 'singer-err' : undefined} value={singer} onChange={(e) => setSinger(e.target.value)} list="recent-singers" autoFocus maxLength={60} autoComplete="off" />
        <datalist id="recent-singers">{singers.map((s) => <option key={s} value={s} />)}</datalist>
      </div>
      {error && <div id="singer-err"><ErrorNote>{error}</ErrorNote></div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>Add to queue</button>
      </div>
    </form>
  );
}

type Worker = AppState['worker'];
type Msg = { ok?: string; err?: string };

export function TrackDialog({ track, activeTrackId, wordAlignmentEnabled = false, worker, onClose, onChanged }: { track: Track | null; activeTrackId: string | null; wordAlignmentEnabled?: boolean; worker?: Worker; onClose: () => void; onChanged: () => void }) {
  // The Modal only exposes onClose, so unsaved edits are guarded here; a controlled dialog stays open if we skip onClose.
  const dirty = useRef(false);
  const close = () => { if (dirty.current && !window.confirm('Discard unsaved changes to this song’s details?')) return; dirty.current = false; onClose(); };
  return (
    <Modal open={!!track} onClose={close} title="Song details" wide>
      {track && <TrackBody key={track.id} track={track} isActive={activeTrackId === track.id} wordAlignmentEnabled={wordAlignmentEnabled} worker={worker} dirtyRef={dirty} onClose={() => { dirty.current = false; onClose(); }} onChanged={onChanged} />}
    </Modal>
  );
}

function waitReason(w: Worker | null) {
  if (!w) return 'Waiting for the preparation worker.';
  if (!w.online) return 'Waiting — the preparation worker is offline.';
  if (w.modelError) return 'Waiting — separation model not installed.';
  if (!w.modelReady) return 'Waiting — separation model is still being prepared.';
  return 'Waiting in line — preparation starts after the songs ahead of it.';
}

function TrackBody({ track, isActive, wordAlignmentEnabled, worker, dirtyRef, onClose, onChanged }: { track: Track; isActive: boolean; wordAlignmentEnabled: boolean; worker?: Worker; dirtyRef: React.RefObject<boolean>; onClose: () => void; onChanged: () => void }) {
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const [album, setAlbum] = useState(track.album);
  const [quality, setQuality] = useState<Quality>(track.quality);
  const [saveState, setSaveState] = useState<Msg>({});
  const [prepState, setPrepState] = useState<Msg>({});
  const [lyricState, setLyricState] = useState<Msg>({});
  const [matches, setMatches] = useState<LyricMatch[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteErr, setDeleteErr] = useState('');
  const [fetchedWorker, setFetchedWorker] = useState<Worker | null>(null);
  const dirty = title !== track.title || artist !== track.artist || album !== track.album;
  const titleErr = !title.trim();
  const working = track.status === 'queued' || track.status === 'running';
  const aligning = track.alignment?.status === 'queued' || track.alignment?.status === 'running';
  const needsWords = track.lyrics.lines.some(line => line.text.trim() && !line.words?.length);
  const w = worker ?? fetchedWorker;
  const matchesRef = useRef<HTMLUListElement>(null);
  const focusMatches = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const confirmWasOpen = useRef(false);
  const alive = useRef(true);
  // Synchronous lock: busy state lands a render late, so a fast second click could otherwise start a parallel action.
  const lock = useRef<string | null>(null);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty, dirtyRef]);
  useEffect(() => {
    // The dialog is not handed the app state, so look up why a queued song is waiting.
    if (worker || track.status !== 'queued') return;
    const ac = new AbortController();
    fetchState('', false, 1, 1, ac.signal).then((s) => setFetchedWorker(s.worker), () => {});
    return () => ac.abort();
  }, [worker, track.status]);
  useEffect(() => {
    if (matches?.length && focusMatches.current) { focusMatches.current = false; matchesRef.current?.focus(); }
  }, [matches]);
  useEffect(() => {
    if (confirmDelete) keepRef.current?.focus();
    else if (confirmWasOpen.current) deleteRef.current?.focus();
    confirmWasOpen.current = confirmDelete;
  }, [confirmDelete]);

  // One action at a time: every mutating button is disabled while any request is in flight.
  const run = async (key: string, fn: () => Promise<void>, set: (s: Msg) => void) => {
    if (lock.current) return;
    lock.current = key;
    setBusy(key);
    set({});
    try { await fn(); } catch (e) { if (alive.current) set({ err: msg(e) }); }
    lock.current = null;
    if (alive.current) setBusy(null);
    onChanged();
  };
  const ok = (set: (s: Msg) => void, text: string) => { if (alive.current) set({ ok: text }); };
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (titleErr) { titleRef.current?.focus(); return; }
    if (!dirty) return;
    void run('save', async () => { await patchTrack(track.id, { title: title.trim(), artist: artist.trim(), album: album.trim() }); ok(setSaveState, 'Saved.'); }, setSaveState);
  };
  const del = () => run('del', async () => {
    try { await deleteTrack(track.id); } catch (e) { if (alive.current) setDeleteErr(msg(e)); return; }
    onClose();
  }, () => setDeleteErr(''));

  return (
    <div className="space-y-6">
      <form onSubmit={save} noValidate aria-labelledby="td-meta" className="space-y-3">
        <h3 id="td-meta" className="font-display text-xl font-bold">Title and artist</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="lbl" htmlFor="td-title">Title</label>
            <input ref={titleRef} id="td-title" className="field" aria-required aria-invalid={titleErr} aria-describedby={titleErr ? 'td-title-err' : undefined} value={title} onChange={(e) => setTitle(e.target.value)} />
            {titleErr && <p id="td-title-err" className="mt-1 text-xs text-[#ffb0c0]">Title is required.</p>}
          </div>
          <div><label className="lbl" htmlFor="td-artist">Artist</label><input id="td-artist" className="field" value={artist} onChange={(e) => setArtist(e.target.value)} /></div>
          <div><label className="lbl" htmlFor="td-album">Album</label><input id="td-album" className="field" value={album} onChange={(e) => setAlbum(e.target.value)} /></div>
        </div>
        <p className="text-xs text-muted-foreground">Saving does not remove lyrics already attached. Use the lyric match below to change them.</p>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-violet" disabled={!dirty || (!!busy && busy !== 'save')}>{busy === 'save' ? 'Saving…' : 'Save details'}</button>
          {dirty && busy !== 'save' && <span className="text-sm text-gold">Unsaved changes</span>}
          {!dirty && saveState.ok && <span role="status" className="text-sm text-mint">{saveState.ok}</span>}
        </div>
        {saveState.err && <ErrorNote>{saveState.err}</ErrorNote>}
      </form>

      <section aria-labelledby="td-prep" className="space-y-3">
        <h3 id="td-prep" className="font-display text-xl font-bold">Audio preparation</h3>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip track={track} />
          <span className="chip chip-dim">{track.quality === 'high' ? 'Higher quality' : 'Balanced'}</span>
          <span className="text-sm text-muted-foreground">{formatTime(track.duration)} · {formatBytes(track.bytes)}</span>
        </div>
        {track.status === 'queued' && (
          <p role="status" className="text-sm text-muted-foreground">
            {waitReason(w)}{w?.online && w.modelError && <span className="mt-0.5 block text-xs">{w.modelError} The song is kept and starts once the model is ready.</span>}
          </p>
        )}
        {track.status === 'running' && (
          <div className="meter h-2" role="progressbar" aria-label="Preparation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(track.progress * 100)}>
            <i style={{ width: `${Math.round(track.progress * 100)}%` }} />
          </div>
        )}
        {track.error && <ErrorNote>{track.error}</ErrorNote>}
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-48">
            <label className="lbl" htmlFor="td-quality">Separation quality</label>
            <select id="td-quality" className="field" value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
              <option value="balanced">Balanced</option>
              <option value="high">Higher quality (slower)</option>
            </select>
          </div>
          <button
            className="btn" disabled={working || !!busy}
            onClick={() => run('retry', async () => { await prepareTrack(track.id, 'retry', quality); ok(setPrepState, 'Preparation queued. Existing finished audio stays playable until the new version is ready.'); }, setPrepState)}
          >
            <RefreshCw size={14} /> {track.status === 'ready' ? 'Prepare again' : 'Retry preparation'}
          </button>
          {working && (
            <button className="btn" disabled={!!busy} onClick={() => run('cancel', async () => { await prepareTrack(track.id, 'cancel'); ok(setPrepState, 'Cancel requested.'); }, setPrepState)}>Cancel preparation</button>
          )}
        </div>
        {prepState.ok && <p role="status" className="text-sm text-mint">{prepState.ok}</p>}
        {prepState.err && <ErrorNote>{prepState.err}</ErrorNote>}
      </section>

      <section aria-labelledby="td-lyrics" className="space-y-3">
        <h3 id="td-lyrics" className="font-display text-xl font-bold">Lyrics</h3>
        <div className="flex flex-wrap items-center gap-2">
          <LyricsChip track={track} />
          {track.lyrics.provider && <span className="text-sm text-muted-foreground">from {track.lyrics.provider}</span>}
        </div>
        {track.lyrics.attribution && <p className="text-xs text-muted-foreground">{track.lyrics.attribution}</p>}
        {wordAlignmentEnabled && needsWords && <p className="text-sm text-muted-foreground">Experimental local word alignment for English lyrics. Some sung vocals cannot be matched reliably. Accepted timings are saved for offline playback; unmatched lines keep their line highlighting.</p>}
        {track.lyrics.alignment && <p className="text-xs text-muted-foreground">Word timing generated locally · {track.lyrics.alignment.alignedLines} of {track.lyrics.alignment.totalLines} lines aligned. Saved for offline playback.</p>}
        {wordAlignmentEnabled && aligning && <p role="status" className="text-sm text-gold">{track.alignment?.status === 'queued' ? 'Word alignment queued. It starts when playback stops.' : `Aligning words to vocals… ${Math.round((track.alignment?.progress ?? 0) * 100)}%`}</p>}
        {wordAlignmentEnabled && track.alignment?.status === 'failed' && <ErrorNote>{track.alignment.error} Existing lyrics are kept.</ErrorNote>}
        <div className="flex flex-wrap gap-2">
          {wordAlignmentEnabled && needsWords && <button className="btn btn-violet" disabled={aligning || track.status !== 'ready' || !!busy} onClick={() => run('align', async () => { await alignTrackLyrics(track.id); ok(setLyricState, 'Word alignment queued. You can keep using the library.'); }, setLyricState)}>Generate word timings</button>}
          {wordAlignmentEnabled && aligning && <button className="btn" disabled={!!busy} onClick={() => run('cancel-align', async () => { await alignTrackLyrics(track.id, 'cancel'); ok(setLyricState, 'Word alignment canceled.'); }, setLyricState)}>Cancel word alignment</button>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn" disabled={!!busy}
            onClick={() => run('lookup', async () => { const r = await lookupLyric(track.id); ok(setLyricState, r.lyrics.kind === 'missing' ? 'No lyrics found for these details.' : 'Lyrics matched automatically.'); }, setLyricState)}
          ><Search size={14} /> Match automatically</button>
          <button
            className="btn" disabled={!!busy}
            onClick={() => run('matches', async () => {
              const r = await lyricMatches(track.id);
              if (!alive.current) return;
              // Focus once the list has rendered; on the first load it does not exist yet.
              focusMatches.current = r.matches.length > 0;
              setMatches(r.matches);
              if (!r.matches.length) setLyricState({ err: 'No candidate lyrics were found. Check the title and artist, then search again.' });
            }, setLyricState)}
          >Choose from matches</button>
        </div>
        {lyricState.ok && <p role="status" className="text-sm text-mint">{lyricState.ok}</p>}
        {lyricState.err && <ErrorNote>{lyricState.err} Lyrics already saved are kept.</ErrorNote>}
        {matches && matches.length > 0 && (
          <ul ref={matchesRef} tabIndex={-1} className="scroll-thin max-h-64 space-y-1 overflow-y-auto rounded-lg border border-white/10 p-1" aria-label="Lyric matches">
            {matches.map((m) => {
              const selected = track.lyrics.providerId === m.id;
              const diff = Math.abs(m.duration - track.duration);
              return (
                <li key={m.id} className="flex items-center gap-2 rounded-md bg-black/20 p-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">{m.trackName} <span className="font-normal text-muted-foreground">· {m.artistName}</span></p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.albumName || 'No album'} · {formatTime(m.duration)}{Number.isFinite(diff) && track.duration ? ` (${diff < 1 ? 'same length' : `${Math.round(diff)}s ${m.duration > track.duration ? 'longer' : 'shorter'}`})` : ''}
                    </p>
                    <p className="mt-0.5 flex gap-1.5">
                      {m.syncedLyrics ? <span className="chip chip-mint">Timed</span> : <span className="chip chip-gold">No timing</span>}
                      {!m.syncedLyrics && !m.plainLyrics && <span className="chip chip-dim">No text</span>}
                    </p>
                  </div>
                  <button
                    className={`btn btn-sm ${selected ? '' : 'btn-violet'}`} disabled={!!busy}
                    onClick={() => run(`m${m.id}`, async () => { await selectLyric(track.id, m.id); ok(setLyricState, 'Lyrics selected and saved for offline use.'); }, setLyricState)}
                  >{selected ? <><Check size={14} /> In use</> : 'Use these'}</button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="td-del" className="space-y-2 border-t border-white/10 pt-4">
        <h3 id="td-del" className="font-display text-xl font-bold">Remove song</h3>
        {isActive ? (
          <p className="text-sm text-muted-foreground">This song is playing. End it before deleting.</p>
        ) : !confirmDelete ? (
          <button ref={deleteRef} className="btn btn-danger" disabled={!!busy} onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete song</button>
        ) : (
          <div className="space-y-2 rounded-lg border border-[#ff7a7a66] bg-[#3a1226] p-3" role="alertdialog" aria-labelledby="td-del-title" aria-describedby="td-del-desc">
            <p id="td-del-title" className="font-bold">Delete this song permanently?</p>
            <p id="td-del-desc" className="text-sm">Delete “{track.title}” and its backing track, guide vocal, original file, and lyrics from this library? This cannot be undone.</p>
            <div className="flex gap-2">
              <button ref={keepRef} className="btn" disabled={busy === 'del'} onClick={() => setConfirmDelete(false)}>Keep song</button>
              <button className="btn btn-danger" disabled={!!busy && busy !== 'del'} aria-disabled={busy === 'del'} onClick={() => void del()}>{busy === 'del' ? 'Deleting…' : 'Delete permanently'}</button>
            </div>
            {deleteErr && <ErrorNote>{deleteErr}</ErrorNote>}
          </div>
        )}
      </section>
    </div>
  );
}

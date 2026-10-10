'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ListMusic, LogIn, LogOut, Mic2, Music2, SlidersHorizontal, Tv2 } from 'lucide-react';
import { AudioEngine, LoadAbortedError } from '@/lib/audio-engine';
import {
  api, ApiError, authAction, fetchState, isLeaseLost, newControllerId, patchTrack, queueRemove, queueReorder, releaseOnExit, session,
} from '@/lib/client-api';
import { TrackCache } from '@/lib/track-cache';
import type { AppState, QueueEntry, Track } from '@/lib/types';
import { AdminPanel } from './admin-panel';
import { LoginForm, SetupScreen } from './auth';
import { LibraryPanel } from './library-panel';
import { Mixer } from './mixer';
import { QueuePanel } from './queue-panel';
import { Stage } from './stage';
import { AddToQueueDialog, TrackDialog } from './track-dialogs';
import { Button } from '@/components/ui/button';
import { ErrorNote, Modal } from './ui-bits';

const PAGE_SIZE = 25;
const POLL_MS = 3000;
const STALL_MS = 10_000;
const HEARTBEAT_MS = 10_000;
const HEARTBEAT_RETRY_MS = 3000;
const QUEUED_TRACK_MAX_AGE_MS = 15_000;
const SIGNED_OUT_NOTE = 'You were signed out, so playback and microphones stopped. Sign in again to continue.';

type View = 'stage' | 'library' | 'queue' | 'mixer';
interface Now { trackId: string; singer: string | null }

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

// In memory per page load: duplicated tabs and blocked storage still get distinct controllers.
let pageControllerId: string | null = null;
const controllerId = () => (pageControllerId ??= newControllerId());

const fetchTrack = async (id: string) => {
  try {
    return (await api<{ track: Track }>(`/api/tracks/${encodeURIComponent(id)}`)).track;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function KaraokeApp() {
  const [engine] = useState(() => new AudioEngine());
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getServerSnapshot);
  useEffect(() => {
    engine.init();
    return () => engine.dispose();
  }, [engine]);

  const [state, setState] = useState<AppState | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [tracks] = useState(() => new TrackCache(fetchTrack));
  useSyncExternalStore(tracks.subscribe, tracks.getVersion, tracks.getVersion);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<View>('stage');
  const [leftTab, setLeftTab] = useState<'songs' | 'add'>('songs');
  const [mixerOpen, setMixerOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  const [now, setNow] = useState<Now | null>(null);
  const [leaseOn, setLeaseOn] = useState(false);
  const [leaseWarning, setLeaseWarning] = useState('');
  const [signedOutNote, setSignedOutNote] = useState('');
  const [starting, setStarting] = useState(false);
  const [playError, setPlayError] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [queueTrack, setQueueTrack] = useState<Track | null>(null);
  const [queueError, setQueueError] = useState('');
  const [offsetDraft, setOffsetDraft] = useState<{ id: string; value: number } | null>(null);
  const pendingOffset = useRef<{ id: string; value: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const startToken = useRef(0);
  const startBusy = useRef(false);
  const signingOut = useRef(false);
  const wasAdmin = useRef(false);
  const nonAdminPolls = useRef(0);
  const reordering = useRef(0);
  const queueVersion = useRef(0);
  const [localQueue, setLocalQueue] = useState<QueueEntry[] | null>(null);

  /** Abandon any start in progress; its awaits see the token change and stop. */
  const cancelStart = useCallback(() => {
    startToken.current++;
    startBusy.current = false;
    setStarting(false);
  }, []);

  /** Stop everything this browser controls, e.g. after the host session ended elsewhere. */
  const dropControl = useCallback((note: string) => {
    cancelStart();
    if (engine.getSnapshot().trackId) engine.unload();
    for (const index of [0, 1] as const) if (engine.getSnapshot().mics[index].status !== 'off') engine.disableMic(index);
    setNow(null); setLeaseOn(false); setLeaseWarning('');
    void session('release', controllerId()).catch(() => undefined);
    setSignedOutNote(note);
  }, [engine, cancelStart]);

  // ---- polling ------------------------------------------------------------
  useEffect(() => {
    let abort: AbortController | null = null;
    let startedAt = 0;
    let alive = true;
    let waiters: (() => void)[] = [];
    // A refresh while a request is in flight queues one more run instead of aborting the slow one.
    const run = async (): Promise<void> => {
      if (abort) return new Promise((resolve) => { waiters.push(resolve); });
      const ctl = new AbortController();
      abort = ctl;
      startedAt = Date.now();
      const qv = queueVersion.current;
      try {
        const s = await fetchState(dq, favoritesOnly, page, PAGE_SIZE, ctl.signal);
        if (!alive) return;
        setOffline(null);
        if (s.admin) {
          nonAdminPolls.current = 0;
          setSignedOutNote('');
        } else if (wasAdmin.current && !signingOut.current) {
          // One stray response shouldn't stop a song; act once a second poll agrees.
          if (++nonAdminPolls.current < 2) { waiters.push(() => undefined); return; }
          dropControl(SIGNED_OUT_NOTE);
        }
        if (!s.admin) signingOut.current = false;
        wasAdmin.current = s.admin;
        setState(s);
        setFetchedAt(Date.now());
        if (reordering.current === 0 && qv === queueVersion.current) setLocalQueue(null);
        tracks.seen(s.tracks);
        const pages = Math.max(1, Math.ceil(s.total / PAGE_SIZE));
        if (page > pages) setPage(pages);
      } catch (e) {
        if (alive && !(e instanceof DOMException && e.name === 'AbortError')) setOffline(msg(e));
      } finally {
        if (abort === ctl) abort = null;
        const pending = waiters;
        waiters = [];
        if (pending.length) {
          if (alive) void run().finally(() => pending.forEach((w) => w()));
          else pending.forEach((w) => w());
        }
      }
    };
    refreshRef.current = run;
    void run();
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      if (!abort) { void run(); return; }
      if (Date.now() - startedAt > STALL_MS) {
        setOffline('The host is taking too long to respond.');
        abort.abort();
      }
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      abort?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [dq, favoritesOnly, page, engine, tracks, dropControl]);

  const refresh = useCallback(() => refreshRef.current(), []);

  // Songs on the stage or in the queue may be off the visible library page; keep them fresh in the background.
  const queue = localQueue ?? state?.queue ?? [];
  useEffect(() => {
    if (!state) return;
    const onPage = new Set(state.tracks.map((t) => t.id));
    const want = new Map<string, number>();
    for (const e of localQueue ?? state.queue) want.set(e.trackId, QUEUED_TRACK_MAX_AGE_MS);
    if (editId) want.set(editId, QUEUED_TRACK_MAX_AGE_MS);
    for (const id of [now?.trackId, state.active?.trackId]) if (id) want.set(id, POLL_MS);
    tracks.sync([...want].map(([id, maxAgeMs]) => ({ id, maxAgeMs: onPage.has(id) ? Infinity : maxAgeMs })));
  }, [state, localQueue, now, editId, tracks]);

  const trackFor = (id: string) => state?.tracks.find((t) => t.id === id) ?? tracks.get(id);

  // ---- session lease ------------------------------------------------------
  const claimLease = useCallback((trackId: string) => session('claim', controllerId(), trackId), []);

  useEffect(() => {
    if (!leaseOn || !now || snap.transport === 'ended') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const beat = async () => {
      let delay = HEARTBEAT_MS;
      try {
        await session('heartbeat', controllerId(), now.trackId);
        if (alive) setLeaseWarning('');
      } catch (e) {
        if (!alive) return;
        if (isLeaseLost(e)) {
          engine.pause();
          setLeaseOn(false);
          setLeaseWarning('');
          setPlayError(`Playback control was lost: ${msg(e)} Press play to try to take it back.`);
          return;
        }
        // Network hiccup or busy host: the lease outlives a few missed beats, so keep singing and retry sooner.
        setLeaseWarning(`Having trouble reaching the host (${msg(e)}). Playback continues; retrying.`);
        delay = HEARTBEAT_RETRY_MS;
      }
      if (alive) timer = setTimeout(beat, delay);
    };
    timer = setTimeout(beat, HEARTBEAT_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [leaseOn, now, snap.transport, engine]);

  // Release the lease when a song finishes; Play again or seek + Play claims it anew.
  useEffect(() => {
    let prev = engine.getSnapshot().transport;
    return engine.subscribe(() => {
      const t = engine.getSnapshot().transport;
      if (t === 'ended' && prev !== 'ended') {
        setLeaseOn(false);
        setLeaseWarning('');
        void session('release', controllerId()).catch(() => undefined);
      }
      prev = t;
    });
  }, [engine]);
  const ended = snap.transport === 'ended';

  useEffect(() => {
    const onHide = () => { if (leaseOn) releaseOnExit(controllerId()); };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [leaseOn]);

  // ---- playback actions ---------------------------------------------------
  const admin = !!state?.admin;
  const active = state?.active ?? null;
  const lockedByOther = !!active && active.controller !== (typeof window === 'undefined' ? '' : controllerId()) && active.expiresAt > fetchedAt;
  const startBlockReason = starting || snap.transport === 'loading' ? 'A song is loading.'
    : lockedByOther ? 'Another browser is controlling playback.' : null;

  const endSong = useCallback(async () => {
    cancelStart();
    engine.unload();
    setNow(null);
    setLeaseOn(false);
    setLeaseWarning('');
    setPlayError('');
    try { await session('release', controllerId()); } catch { /* lease expires on its own */ }
    void refresh();
  }, [engine, refresh, cancelStart]);

  const startTrack = async (track: Track, entry?: QueueEntry) => {
    engine.unlock();
    if (startBusy.current || engine.getSnapshot().transport === 'loading' || lockedByOther) return;
    startBusy.current = true;
    const token = ++startToken.current;
    const cancelled = () => token !== startToken.current;
    setStarting(true);
    setPlayError('');
    setLeaseWarning('');
    setView('stage');
    try {
      if (engine.getSnapshot().trackId) engine.unload();
      try {
        await claimLease(track.id);
      } catch (e) {
        if (!cancelled()) { setPlayError(msg(e)); setNow(null); setLeaseOn(false); }
        return;
      }
      if (cancelled()) {
        // Ended while claiming: give the lease back unless a newer start already took it.
        if (!startBusy.current) void session('release', controllerId()).catch(() => undefined);
        return;
      }
      setNow({ trackId: track.id, singer: entry?.singer ?? null });
      setLeaseOn(true);
      try {
        await engine.load(track.id);
      } catch (e) {
        if (e instanceof LoadAbortedError || cancelled()) return;
        setPlayError(msg(e));
        setLeaseOn(false);
        void session('release', controllerId()).catch(() => undefined);
        return;
      }
      if (cancelled()) return;
      if (entry) {
        try { await queueRemove(entry.id); } catch (e) { setPlayError(`The song started, but it could not be removed from the queue: ${msg(e)}`); }
        if (cancelled()) return;
      }
      engine.play();
      void refresh();
    } finally {
      if (!cancelled()) { startBusy.current = false; setStarting(false); }
    }
  };

  const onPlayPause = async () => {
    engine.unlock();
    if (snap.transport === 'playing') { engine.pause(); return; }
    if (!now) return;
    setPlayError('');
    if (snap.transport === 'ended' || !leaseOn) {
      try { await claimLease(now.trackId); setLeaseOn(true); } catch (e) { setPlayError(msg(e)); return; }
    }
    engine.play();
  };

  const startNext = () => {
    const first = queue[0];
    const t = first && trackFor(first.trackId);
    if (first && t) void startTrack(t, first);
  };

  // keyboard shortcuts for the host
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!admin || !now || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(el.tagName) || el.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); void onPlayPause(); }
      else if (e.key === 'ArrowRight') engine.seek(engine.getPosition() + 5);
      else if (e.key === 'ArrowLeft') engine.seek(engine.getPosition() - 5);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- library / queue actions ---------------------------------------------
  const toggleFavorite = async (t: Track) => {
    setState((s) => s && { ...s, tracks: s.tracks.map((x) => (x.id === t.id ? { ...x, favorite: !t.favorite } : x)) });
    try { await patchTrack(t.id, { favorite: !t.favorite }); } catch (e) { setQueueError(msg(e)); }
    void refresh();
  };

  const reorder = async (ids: string[]) => {
    // Keep the optimistic order until a poll started after the PATCH settled replaces it.
    queueVersion.current++;
    reordering.current++;
    setLocalQueue(ids.map((id, i) => ({ ...queue.find((e) => e.id === id)!, position: i })));
    try { await queueReorder(ids); } catch (e) { setQueueError(msg(e)); } finally { reordering.current--; }
    void refresh();
  };

  const removeEntry = async (entry: QueueEntry) => {
    try { await queueRemove(entry.id); } catch (e) { setQueueError(msg(e)); }
    void refresh();
  };

  const saveOffset = useCallback((id: string, value: number) => {
    patchTrack(id, { lyricOffset: value })
      .then(() => {
        setState((s) => s && { ...s, tracks: s.tracks.map((t) => (t.id === id ? { ...t, lyricOffset: value } : t)) });
        tracks.patch(id, { lyricOffset: value });
      })
      .catch((e) => setPlayError(`Lyric timing could not be saved: ${msg(e)}`))
      .finally(() => setOffsetDraft((d) => (d && d.id === id && d.value === value ? null : d)));
  }, [tracks]);

  const flushOffset = useCallback(() => {
    const p = pendingOffset.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingOffset.current = null;
    saveOffset(p.id, p.value);
  }, [saveOffset]);

  const onOffset = (value: number) => {
    if (!now) return;
    const id = now.trackId;
    if (pendingOffset.current) clearTimeout(pendingOffset.current.timer);
    setOffsetDraft({ id, value });
    pendingOffset.current = { id, value, timer: setTimeout(flushOffset, 600) };
  };
  // Save a pending offset right away when the song changes or the app unmounts.
  const nowTrackId = now?.trackId;
  useEffect(() => flushOffset, [nowTrackId, flushOffset]);

  const signOut = async () => {
    signingOut.current = true;
    if (now) await endSong();
    engine.disableMic(0); engine.disableMic(1);
    try { await authAction('logout', ''); } catch { signingOut.current = false; }
    void refresh();
  };

  // ---- render -------------------------------------------------------------
  if (!state) {
    return (
      <main className="stage flex min-h-dvh items-center justify-center p-6 text-center">
        <div>
          <h1 className="font-display text-6xl font-extrabold tracking-wide">KaraokeThing</h1>
          {offline ? (
            <div className="mx-auto mt-4 max-w-md"><ErrorNote>{offline}</ErrorNote><button className="btn mt-3" onClick={() => void refresh()}>Try again</button></div>
          ) : <p className="mt-2 text-muted-foreground" role="status">Connecting to the host…</p>}
        </div>
      </main>
    );
  }

  if (state.setupRequired) return <SetupScreen onDone={() => void refresh()} />;

  const nowTrack = now ? trackFor(now.trackId) ?? null : null;
  const remoteTrack = !now && active ? trackFor(active.trackId) : undefined;
  const editTrack = editId ? trackFor(editId) ?? null : null;
  const first = queue[0];
  const firstTrack = first ? trackFor(first.trackId) : undefined;
  const nextUp = first ? `${first.singer}${firstTrack ? `, ${firstTrack.title}` : ''}` : null;
  const libraryEmpty = state.total === 0 && !dq.trim() && !favoritesOnly;
  const offset = nowTrack ? (offsetDraft?.id === nowTrack.id ? offsetDraft.value : nowTrack.lyricOffset) : 0;
  const singers = Array.from(new Set(queue.map((e) => e.singer)));

  const idle = (
    <div>
      <p className="font-display text-[clamp(2.4rem,8cqw,5.5rem)] font-extrabold leading-none tracking-wide">
        {admin ? (libraryEmpty ? 'Add the first song' : 'Ready when you are') : remoteTrack ? 'Now singing' : 'Nothing playing'}
      </p>
      <p className="mt-3 text-white/75">
        {admin
          ? libraryEmpty ? 'Upload audio files or import a folder. Songs become singable once their backing track is prepared.'
            : lockedByOther ? 'Another browser is controlling playback right now.'
            : 'Pick a ready song from the library, or start the next singer in the queue.'
          : remoteTrack ? `${remoteTrack.title} by ${remoteTrack.artist}. Sound and lyrics play on the host’s screen.`
          : 'You can browse the library and queue. The host controls playback.'}
      </p>
      {admin && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {libraryEmpty ? (
            <Button className="btn btn-primary" onClick={() => { setLeftTab('add'); setView('library'); }}>Add songs</Button>
          ) : first && firstTrack?.status === 'ready' && !startBlockReason ? (
            <Button className="btn btn-primary h-auto max-w-full" style={{ whiteSpace: 'normal' }} onClick={startNext}>Start {first.singer}’s song</Button>
          ) : null}
        </div>
      )}
    </div>
  );

  const notice = (
    <>
      {playError && <ErrorNote>{playError}</ErrorNote>}
      {leaseWarning && <ErrorNote tone="warn">{leaseWarning}</ErrorNote>}
      {ended && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/40 px-3 py-2 text-sm">
          <span>Song finished. Nothing starts until you choose.</span>
          {admin && first && firstTrack?.status === 'ready' && !startBlockReason && (
            <Button className="btn btn-primary btn-sm h-auto max-w-full" style={{ whiteSpace: 'normal' }} onClick={startNext}>Start {first.singer}’s song</Button>
          )}
        </div>
      )}
    </>
  );

  const navBtn = (v: View, label: string, icon: React.ReactNode) => (
    <button key={v} className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-bold ${view === v ? 'text-gold' : 'text-white/70'}`} aria-current={view === v ? 'page' : undefined} onClick={() => setView(v)}>
      {icon}{label}
    </button>
  );

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <header className="flex items-center gap-3 border-b border-white/10 bg-plum-950/60 px-4 py-2.5">
        <span className="brand-mark" aria-hidden><Mic2 size={18} /></span>
        <h1 className="font-display text-3xl font-extrabold leading-none tracking-wide">KaraokeThing</h1>
        <div className="ml-auto flex items-center gap-2">
          {admin && state.worker.processing && <span className="chip chip-gold hidden sm:inline-flex">Preparing a song</span>}
          {admin && !state.worker.online && <span className="chip chip-coral hidden sm:inline-flex">Worker offline</span>}
          <span className="hidden text-sm text-muted-foreground sm:inline">{admin ? 'Host' : 'Viewing only'}</span>
          {admin ? (
            <Button className="btn btn-sm" onClick={signOut}><LogOut size={14} /> Sign out</Button>
          ) : (
            <Button className="btn btn-sm btn-primary" onClick={() => setLoginOpen(true)}><LogIn size={14} /> Host sign in</Button>
          )}
        </div>
      </header>

      {offline && <div className="px-3 pt-2"><ErrorNote tone="warn">Lost contact with the host: {offline} Showing the last data received; retrying every few seconds.</ErrorNote></div>}
      {signedOutNote && !admin && <div className="px-3 pt-2"><ErrorNote tone="warn">{signedOutNote} <button className="underline" onClick={() => setSignedOutNote('')}>Dismiss</button></ErrorNote></div>}
      {queueError && <div className="px-3 pt-2"><ErrorNote>{queueError} <button className="underline" onClick={() => setQueueError('')}>Dismiss</button></ErrorNote></div>}

      <main className="grid min-h-0 flex-1 gap-3 p-3 pb-16 lg:grid-cols-[21rem_minmax(0,1fr)_20rem] lg:pb-3">
        <aside aria-label="Library" className={`${view === 'library' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col gap-3 lg:flex`}>
          {admin && (
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/30 p-1" role="tablist" aria-label="Library sections">
              {(['songs', 'add'] as const).map((t) => (
                <button key={t} role="tab" aria-selected={leftTab === t} className={`btn btn-sm border-0 ${leftTab === t ? 'btn-violet' : 'btn-ghost'}`} onClick={() => setLeftTab(t)}>{t === 'songs' ? 'Songs' : 'Add songs'}</button>
              ))}
            </div>
          )}
          {/* Stays mounted while hidden so uploads keep their progress across tab switches. */}
          {admin && <div className={leftTab === 'add' ? 'contents' : 'hidden'}><AdminPanel state={state} onChanged={() => void refresh()} /></div>}
          {!(admin && leftTab === 'add') && (
            <LibraryPanel
              tracks={state.tracks} total={state.total} page={page} pageSize={PAGE_SIZE}
              q={q} onQ={(v) => { setQ(v); setPage(1); }} favoritesOnly={favoritesOnly} onFavoritesOnly={(v) => { setFavoritesOnly(v); setPage(1); }}
              onPage={setPage} admin={admin} loaded playingId={now?.trackId ?? active?.trackId ?? null}
              playDisabledReason={startBlockReason} onPlay={(t) => void startTrack(t)} onQueue={setQueueTrack}
              onEdit={(t) => setEditId(t.id)} onFavorite={(t) => void toggleFavorite(t)} onGoAdd={() => setLeftTab('add')}
            />
          )}
        </aside>

        <div className={`${view === 'stage' || view === 'mixer' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col gap-3 lg:flex`}>
          <div className={`${view === 'stage' ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col lg:flex`}>
            <Stage
              engine={engine} snap={snap} track={nowTrack} singer={now?.singer ?? null} nextUp={nextUp}
              canControl={admin && !!now} offset={offset} onOffset={onOffset} onPlayPause={() => void onPlayPause()} onStop={() => void endSong()}
              notice={notice} idle={idle}
            />
          </div>
          {admin && (
            <div className={`${view === 'mixer' ? 'block' : 'hidden'} min-h-0 lg:block`}>
              <button className="btn btn-sm mb-2 hidden lg:inline-flex" aria-expanded={mixerOpen} onClick={() => setMixerOpen((v) => !v)}>
                <SlidersHorizontal size={14} /> {mixerOpen ? 'Hide mixer' : 'Show mixer'}
              </button>
              <div className={`scroll-thin lg:max-h-[42dvh] lg:overflow-y-auto ${mixerOpen ? '' : 'lg:hidden'}`}><Mixer engine={engine} snap={snap} /></div>
            </div>
          )}
        </div>

        <aside aria-label="Singer queue" className={`${view === 'queue' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col gap-3 lg:flex`}>
          <h2 className="flex items-baseline gap-2 font-display text-2xl font-bold tracking-wide">Singer queue{queue.length > 0 && <span className="text-base font-semibold text-muted-foreground">{queue.length} waiting</span>}</h2>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
            <QueuePanel
              queue={queue} trackFor={trackFor} isGone={(id) => tracks.isGone(id)} admin={admin} startDisabledReason={startBlockReason}
              onStart={(e) => { const t = trackFor(e.trackId); if (t) void startTrack(t, e); }}
              onRemove={(e) => void removeEntry(e)} onReorder={(ids) => void reorder(ids)}
            />
          </div>
          {admin && <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Tv2 size={14} className="mt-0.5 shrink-0" aria-hidden />Songs never start by themselves. Use Start on a queue entry when the singer is ready.</p>}
        </aside>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-white/10 bg-plum-950/95 backdrop-blur lg:hidden" aria-label="Sections">
        {navBtn('stage', 'Stage', <Music2 size={18} />)}
        {navBtn('library', 'Library', <ListMusic size={18} />)}
        {navBtn('queue', 'Queue', <Mic2 size={18} />)}
        {admin && navBtn('mixer', 'Mixer', <SlidersHorizontal size={18} />)}
      </nav>

      <Modal open={loginOpen && !admin} onClose={() => setLoginOpen(false)} title="Host sign in">
        <LoginForm onDone={() => { setLoginOpen(false); void refresh(); }} />
      </Modal>
      <AddToQueueDialog
        track={queueTrack} singers={singers} onClose={() => setQueueTrack(null)}
        onAdded={(t) => { tracks.seen([t]); void refresh(); }}
      />
      <TrackDialog track={editTrack} activeTrackId={now?.trackId ?? active?.trackId ?? null} wordAlignmentEnabled={state.wordAlignmentEnabled} onClose={() => setEditId(null)} onChanged={() => { if (editId) tracks.invalidate(editId); void refresh(); }} />
    </div>
  );
}

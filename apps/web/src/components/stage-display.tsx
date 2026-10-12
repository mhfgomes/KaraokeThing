'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic2, Volume2, WifiOff } from 'lucide-react';
import { AudioEngine, type EngineSnapshot } from '@/lib/audio-engine';
import { api, ApiError } from '@/lib/client-api';
import type { StageDesired, StageFeed, StageReport, Track } from '@/lib/types';
import { Lyrics, useReducedMotion } from './stage';

const REPORT_MS = 500;
const TRACK_REFRESH_MS = 4000;
const KEY_STORAGE = 'karaoke-stage-key';

/** The pairing key arrives as `#key=…` once; keep it so reloads and restarts stay paired. */
let cachedKey: string | null | undefined;
function stageKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('key');
  try {
    if (fromHash) localStorage.setItem(KEY_STORAGE, fromHash);
    cachedKey = fromHash || localStorage.getItem(KEY_STORAGE);
  } catch { cachedKey = fromHash; }
  if (fromHash) history.replaceState(null, '', window.location.pathname);
  return cachedKey;
}
const subscribeNever = () => () => undefined;

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

function buildReport(engine: AudioEngine, s: EngineSnapshot): Omit<StageReport, 'at'> {
  return {
    trackId: s.trackId, transport: s.transport, position: engine.getPosition(), duration: s.duration, loadProgress: s.loadProgress,
    error: s.error ?? s.guideError, hasGuide: s.hasGuide, soundBlocked: s.contextState === 'suspended', micSupported: s.micSupported,
    devices: s.devices.slice(0, 64), mics: s.mics.map((m) => ({ status: m.status, error: m.error, label: m.label })),
  };
}

/** Makes the local engine match what the host asked for. Safe to call repeatedly. */
class Reconciler {
  private trackId: string | null = null;
  private appliedRev = -1;
  private retriedRev = -1;
  private micDevice: [string | null, string | null] = [null, null];
  private micTried = ['', ''];

  constructor(private engine: AudioEngine) {}

  apply(d: StageDesired) {
    const e = this.engine;
    let s = e.getSnapshot();
    if (s.backingGain !== d.backingGain) e.setBackingGain(d.backingGain);
    if (s.guideGain !== d.guideGain) e.setGuideGain(d.guideGain);
    if (s.backingMuted !== d.backingMuted) e.setBackingMuted(d.backingMuted);
    if (s.guideMuted !== d.guideMuted) e.setGuideMuted(d.guideMuted);

    if (d.trackId !== this.trackId || (d.trackId && s.transport === 'error' && this.retriedRev !== d.transportRev)) {
      // A new load command for a song that failed to load is a retry.
      if (d.trackId === this.trackId) this.retriedRev = d.transportRev;
      this.trackId = d.trackId;
      this.appliedRev = -1;
      if (d.trackId) e.load(d.trackId).catch(() => undefined); // Failures show up in the snapshot and the report.
      else e.unload();
    }
    s = e.getSnapshot();
    if (d.trackId && this.appliedRev !== d.transportRev && ['ready', 'playing', 'paused', 'ended'].includes(s.transport)) {
      this.appliedRev = d.transportRev;
      e.seek(d.position);
      if (d.playing) e.play(); else e.pause();
    }

    for (const i of [0, 1] as const) {
      const want = d.mics[i];
      const m = e.getSnapshot().mics[i];
      if (m.mode !== want.mode) e.setMicMode(i, want.mode);
      if (m.gain !== want.gain) e.setMicGain(i, want.gain);
      if (m.muted !== want.muted) e.setMicMuted(i, want.muted);
      if (m.monitor !== want.monitor) e.setMicMonitor(i, want.monitor);
      // The engine fills in the real device id once a default input opens, so compare against what was asked.
      if (this.micDevice[i] !== want.deviceId) { this.micDevice[i] = want.deviceId; e.setMicDevice(i, want.deviceId); }
      const attempt = want.deviceId || 'default';
      if (!want.enabled) {
        if (m.status !== 'off') e.disableMic(i);
        this.micTried[i] = '';
      } else if (m.status === 'off' && this.micTried[i] !== attempt) {
        // A failed input stays failed until the host changes it or turns it off and on again.
        this.micTried[i] = attempt;
        void e.enableMic(i);
      }
    }
  }
}

export function StageDisplay() {
  const [engine] = useState(() => new AudioEngine());
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getServerSnapshot);
  const key = useSyncExternalStore(subscribeNever, stageKey, () => undefined);
  const reduced = useReducedMotion();
  const [feed, setFeed] = useState<StageFeed | null>(null);
  const [problem, setProblem] = useState<{ unpaired: boolean; text: string } | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const reconciler = useRef<Reconciler | null>(null);

  useEffect(() => {
    engine.init();
    return () => engine.dispose();
  }, [engine]);

  useEffect(() => {
    if (!key) return;
    reconciler.current ??= new Reconciler(engine);
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const f = await api<StageFeed>('/api/stage/report', {
          method: 'POST', headers: { 'x-stage-key': key }, json: buildReport(engine, engine.getSnapshot()),
        });
        if (!alive) return;
        setFeed(f);
        setProblem(null);
        reconciler.current!.apply(f.desired);
      } catch (e) {
        if (!alive) return;
        // Keep singing through network hiccups; only a rejected key stops the show.
        const unpaired = e instanceof ApiError && e.status === 401;
        if (unpaired) engine.unload();
        setProblem({ unpaired, text: msg(e) });
      }
      if (alive) timer = setTimeout(tick, REPORT_MS);
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [engine, key]);

  // Lyrics and timing offset can be edited from the admin panel mid-song.
  const trackId = feed?.desired.trackId ?? null;
  useEffect(() => {
    if (!trackId) return;
    let alive = true;
    const load = () => api<{ track: Track }>(`/api/tracks/${encodeURIComponent(trackId)}`)
      .then((r) => { if (alive) setTrack(r.track); })
      .catch(() => undefined);
    void load();
    const timer = setInterval(load, TRACK_REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [trackId]);

  const d = feed?.desired;
  const shownTrack = track && track.id === trackId && snap.trackId === trackId ? track : null;
  const playing = snap.transport === 'playing';
  const lyrics = shownTrack?.lyrics;
  const offset = shownTrack?.lyricOffset ?? 0;
  const clock = () => engine.getAudiblePosition() - offset;
  const hasLines = !!lyrics && (lyrics.kind === 'word' || lyrics.kind === 'line') && lyrics.lines.length > 0;
  const loadPct = Math.round(snap.loadProgress * 100);

  if (key === undefined) return <main className="stage stage-display h-dvh" />;
  if (!key || problem?.unpaired) {
    return (
      <main className="stage stage-display flex h-dvh items-center justify-center p-10 text-center">
        <div className="max-w-2xl">
          <span className="brand-mark mx-auto mb-6 size-16" aria-hidden><Mic2 size={34} /></span>
          <h1 className="font-display text-6xl font-extrabold tracking-wide">Stage display not paired</h1>
          <p className="mt-4 text-xl text-white/75">
            On the host, sign in and open <b>Stage</b> in the side panel. Copy the stage link and paste it into the KaraokeThing Stage app, or open it in a browser on this screen.
          </p>
          {problem?.unpaired && <p className="mt-3 text-white/55">{problem.text}</p>}
        </div>
      </main>
    );
  }

  let center: React.ReactNode;
  if (!d?.trackId || !shownTrack) {
    center = snap.transport === 'loading' ? null : (
      <div className="text-center">
        <p className="font-display text-[clamp(3rem,9cqw,8rem)] font-extrabold leading-none tracking-wide">KaraokeThing</p>
        {feed?.nextUp
          ? <p className="mt-[2cqw] text-[clamp(1.4rem,3.4cqw,3rem)] text-white/80"><span className="font-bold text-mint">Up next:</span> {feed.nextUp}</p>
          : <p className="mt-[2cqw] text-[clamp(1.2rem,2.4cqw,2rem)] text-white/60">{feed ? 'Waiting for the host to start a song' : 'Connecting to the host…'}</p>}
      </div>
    );
  }
  if (snap.transport === 'loading') {
    center = (
      <div className="w-full max-w-xl text-center">
        <p className="font-display text-[clamp(2rem,4cqw,3.5rem)] font-bold" role="status">{shownTrack?.title ?? 'Loading'}</p>
        <div className="meter mt-6 h-3" role="progressbar" aria-label="Loading song" aria-valuemin={0} aria-valuemax={100} aria-valuenow={loadPct}><i style={{ width: `${loadPct}%` }} /></div>
      </div>
    );
  } else if (shownTrack && snap.transport === 'error') {
    center = <p role="alert" className="max-w-3xl text-center text-[clamp(1.2rem,2.4cqw,2rem)] text-[#ffd6dc]">{snap.error}</p>;
  } else if (shownTrack && hasLines) {
    center = <Lyrics lines={lyrics!.lines} wordMode={lyrics!.kind === 'word'} clock={clock} playing={playing} reduced={reduced} ended={snap.transport === 'ended'} />;
  } else if (shownTrack && lyrics?.plain.trim()) {
    center = <p className="scroll-thin max-h-full max-w-4xl overflow-y-auto whitespace-pre-wrap text-center text-[clamp(1.2rem,2.6cqw,2.2rem)] leading-relaxed">{lyrics.plain}</p>;
  } else if (shownTrack) {
    center = <p className="font-display text-[clamp(2rem,5cqw,4.5rem)] font-bold text-white/80">♪ {shownTrack.title} ♪</p>;
  }

  return (
    <main className="stage stage-display flex h-dvh flex-col" data-live={playing}>
      <div className="beam beam-a" aria-hidden />
      <div className="beam beam-b" aria-hidden />
      <div className="beam beam-c" aria-hidden />

      <header className="flex min-h-[7cqw] items-start justify-between gap-4 px-[3cqw] pt-[2.2cqw]">
        <div className="min-w-0">
          {shownTrack && (
            <>
              <h1 className="truncate font-display text-[clamp(1.6rem,3.2cqw,3rem)] font-bold leading-none tracking-wide">{shownTrack.title}</h1>
              <p className="mt-1 truncate text-[clamp(1rem,1.6cqw,1.5rem)] text-white/70">{shownTrack.artist}</p>
            </>
          )}
        </div>
        {shownTrack && d?.showSinger && d.singer && (
          <span className="max-w-[40cqw] shrink-0 truncate rounded-full bg-coral px-[1.4cqw] py-[0.4cqw] font-display text-[clamp(1.2rem,2.4cqw,2.2rem)] font-bold text-plum-950">{d.singer}</span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-[4cqw] py-[2cqw]">{center}</div>

      <footer className="px-[3cqw] pb-[1.8cqw] text-center">
        {shownTrack && lyrics?.attribution && <p className="truncate text-[clamp(.8rem,1.1cqw,1.1rem)] text-white/45">{lyrics.attribution}</p>}
        {shownTrack && feed?.nextUp && (
          <p className="mt-1 truncate text-[clamp(1rem,1.8cqw,1.8rem)] text-white/75"><span className="font-bold text-mint">Up next:</span> {feed.nextUp}</p>
        )}
      </footer>

      {problem && (
        <p role="status" className="absolute bottom-3 right-3 flex items-center gap-2 rounded-lg bg-black/60 px-3 py-1.5 text-sm text-[#ffe9ab]">
          <WifiOff size={14} aria-hidden /> Lost contact with the host. Retrying…
        </p>
      )}
      {snap.contextState === 'suspended' && (
        <button className="absolute inset-0 z-10 flex cursor-pointer flex-col items-center justify-center gap-4 bg-black/70 text-center" onClick={() => engine.unlock()}>
          <Volume2 size={56} aria-hidden />
          <span className="font-display text-5xl font-bold">Click to turn on sound</span>
          <span className="text-lg text-white/70">This browser blocks sound until someone clicks. The KaraokeThing Stage app doesn’t need this.</span>
        </button>
      )}
    </main>
  );
}

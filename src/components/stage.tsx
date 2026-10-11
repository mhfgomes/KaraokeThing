'use client';

import { Fragment, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Maximize2, Minimize2, Pause, Play, Square, SlidersHorizontal, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { AudioEngine, EngineSnapshot } from '@/lib/audio-engine';
import { formatTime } from '@/lib/client-api';
import type { LyricLine, Track } from '@/lib/types';
import { currentLyricIndex, gapCountdown, isBlankLine, sungLineBefore, sungLinesAfter, wordProgress } from '@/lib/lyric-timing';
import { Slider } from './ui-bits';
import { Button } from '@/components/ui/button';

const subscribeMotion = (cb: () => void) => {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const useReducedMotion = () =>
  useSyncExternalStore(subscribeMotion, () => window.matchMedia('(prefers-reduced-motion: reduce)').matches, () => false);

const subscribeFs = (cb: () => void) => {
  document.addEventListener('fullscreenchange', cb);
  return () => document.removeEventListener('fullscreenchange', cb);
};
const subscribeNever = () => () => undefined;

/** Polls `read` every frame while playing but re-renders only when its value changes. */
function useTicker<T>(playing: boolean, read: () => T): T {
  const [, setValue] = useState(read);
  const tick = useEffectEvent(() => setValue(read()));
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => { tick(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  return read();
}

/** Characters past which the current line drops to a size that fits three rows in the two-row slot. */
const LONG_LINE = 40;

function WordLine({ line, clock, playing, reduced }: { line: LyricLine; clock: () => number; playing: boolean; reduced: boolean }) {
  const words = line.words!;
  // Reduced motion lights each word whole as it starts, so it re-renders per word instead of per frame.
  const v = useTicker(playing, () => { const t = clock(); return reduced ? words.filter((w) => t >= w.start).length : t; });
  return (
    <>
      {words.map((w, i) => {
        const p = reduced ? (i < v ? 1 : 0) : wordProgress(line, i, v);
        return (
          <Fragment key={i}>
            {i > 0 && ' '}
            {p >= 1 ? <span className="w w-done">{w.text}</span>
              : p <= 0 ? <span className="w">{w.text}</span>
              : <span className="w w-fill" style={{ ['--p' as string]: `${p * 100}%` }}>{w.text}</span>}
          </Fragment>
        );
      })}
    </>
  );
}

function Lyrics({ lines, wordMode, clock, playing, reduced, ended }: {
  lines: LyricLine[]; wordMode: boolean; clock: () => number; playing: boolean; reduced: boolean; ended: boolean;
}) {
  const idx = useTicker(playing, () => currentLyricIndex(lines, clock()));
  const count = useTicker(playing, () => gapCountdown(lines, idx, clock()));
  const cur = idx >= 0 && !isBlankLine(lines[idx]) ? lines[idx] : null;
  const prev = sungLineBefore(lines, idx);
  const upcoming = sungLinesAfter(lines, idx, 2);
  // The current line is anchored mid-stage in a fixed slot; neighbours grow away from it, so wrapping never shifts it.
  return (
    <div className="grid w-full self-stretch grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-[2.2cqw]" aria-live="off">
      <div className="flex min-h-0 flex-col items-center justify-end overflow-hidden">
        <p className="lyric lyric-prev line-clamp-2" aria-hidden>{prev?.text}</p>
      </div>
      <div className="lyric-now-slot">
        <p key={idx} className={`lyric lyric-now lyric-line-enter ${cur && cur.text.length > LONG_LINE ? 'lyric-long' : ''}`}>
          {cur
            ? wordMode && cur.words?.length
              ? <WordLine line={cur} clock={clock} playing={playing} reduced={reduced} />
              : <span className="line-now">{cur.text}</span>
            : count !== null
              ? <span className="text-gold">{count}</span>
              : idx < 0
                ? <span className="text-white/60 text-[0.5em]">{lines.length && !ended ? 'Get ready…' : ''}</span>
                : <span className="text-white/60" role="img" aria-label="Instrumental">♪</span>}
        </p>
      </div>
      <div className="flex min-h-0 flex-col items-center gap-[1.2cqw] overflow-hidden">
        {upcoming.map((l, i) => <p key={idx + 1 + i} className="lyric lyric-next line-clamp-2">{l.text}</p>)}
      </div>
    </div>
  );
}

function SeekBar({ engine, playing, scrub, duration, disabled, timer, onScrub }: {
  engine: AudioEngine; playing: boolean; scrub: number | null; duration: number; disabled: boolean; timer: string; onScrub: (v: number | null) => void;
}) {
  // Quarter-second steps keep the thumb moving smoothly without re-rendering the slider every frame.
  const pos = useTicker(playing, () => scrub ?? Math.round(engine.getPosition() * 4) / 4);
  return (
    <>
      <span className={`w-[3.4em] text-right font-mono tabular-nums ${timer}`} aria-hidden>{formatTime(pos)}</span>
      <Slider
        className="order-first basis-full sm:order-none sm:basis-auto sm:flex-1" label="Seek position" value={Math.min(pos, duration || 1)} max={duration || 1} step={0.1}
        disabled={disabled} valueText={`${formatTime(pos)} of ${formatTime(duration)}`} color="#ffd465"
        onChange={onScrub} onCommit={(v) => { onScrub(null); engine.seek(v); }}
      />
      <span className={`w-[3.4em] font-mono tabular-nums text-white/70 ${timer}`} aria-hidden>{formatTime(duration)}</span>
    </>
  );
}

export interface StageProps {
  engine: AudioEngine;
  snap: EngineSnapshot;
  track: Track | null;
  singer: string | null;
  nextUp: string | null;
  canControl: boolean;
  offset: number;
  onOffset: (v: number) => void;
  onPlayPause: () => void;
  onStop: () => void;
  notice?: ReactNode;
  idle: ReactNode;
}

export function Stage({ engine, snap, track, singer, nextUp, canControl, offset, onOffset, onPlayPause, onStop, notice, idle }: StageProps) {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const fullscreen = useSyncExternalStore(subscribeFs, () => !!document.fullscreenElement, () => false);
  // iPhone Safari has no element fullscreen; the server snapshot keeps hydration consistent.
  const canFullscreen = useSyncExternalStore(subscribeNever, () => !!document.fullscreenEnabled, () => false);
  const [showTiming, setShowTiming] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const playing = snap.transport === 'playing';

  // Seek only when the drag is committed; restarting sources on every drag event stutters.
  useEffect(() => {
    if (scrub === null) return;
    const end = () => setScrub(null);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
  }, [scrub]);

  // Read by the ticking children; Stage itself only re-renders on snapshot, scrub, and prop changes.
  const clock = () => (scrub ?? engine.getAudiblePosition()) - offset;
  const lyrics = track?.lyrics;
  const loaded = track && snap.trackId === track.id && snap.transport !== 'idle';
  const hasLines = !!lyrics && (lyrics.kind === 'word' || lyrics.kind === 'line') && lyrics.lines.length > 0;
  const mode: 'lines' | 'plain' | 'missing' = hasLines ? 'lines' : lyrics && lyrics.plain.trim() ? 'plain' : 'missing';

  const toggleFs = () => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => undefined);
  };

  const live = !!loaded && snap.transport !== 'error';
  const canSeek = canControl && live && snap.transport !== 'loading';
  const wordMode = lyrics?.kind === 'word';
  const loadPct = Math.round(snap.loadProgress * 100);

  return (
    <section
      ref={ref}
      aria-label="Stage"
      data-live={live && playing}
      className="stage flex min-h-[26rem] flex-1 flex-col rounded-2xl border border-white/10 lg:min-h-0"
    >
      <div className="beam beam-a" aria-hidden />
      <div className="beam beam-b" aria-hidden />
      <div className="beam beam-c" aria-hidden />

      <header className="flex items-start justify-between gap-3 px-[3cqw] pt-[2.2cqw] max-sm:px-4 max-sm:pt-3">
        <div className="min-w-0">
          {track && loaded ? (
            <>
              <h2 className="truncate font-display text-[clamp(1.4rem,3.2cqw,2.6rem)] font-bold leading-none tracking-wide">{track.title}</h2>
              <p className="mt-1 truncate text-[clamp(.85rem,1.6cqw,1.15rem)] text-white/70">{track.artist}</p>
            </>
          ) : (
            <p className="font-display text-[clamp(1.2rem,2.6cqw,2rem)] font-bold tracking-wide text-white/70">Stage</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {singer && loaded && (
            <span className="max-w-[40cqw] truncate rounded-full bg-coral px-3.5 py-1 font-display text-[clamp(1rem,2cqw,1.5rem)] font-bold text-plum-950">
              {singer}
            </span>
          )}
          {canFullscreen && (
            <Button className="btn btn-icon" onClick={toggleFs} aria-label={fullscreen ? 'Leave full screen' : 'Show stage full screen'} aria-pressed={fullscreen}>
              {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-[4cqw] py-4 max-sm:px-3">
        {!loaded ? (
          <div className="w-full min-w-0 max-w-xl text-center">{idle}</div>
        ) : snap.transport === 'loading' ? (
          <div className="w-full max-w-md text-center">
            <p className="font-display text-3xl font-bold" role="status">{snap.loadStage || 'Loading'}</p>
            <div className="meter mt-4 h-2" role="progressbar" aria-label="Loading song" aria-valuemin={0} aria-valuemax={100} aria-valuenow={loadPct}>
              <i style={{ width: `${loadPct}%` }} />
            </div>
            <p className="mt-2 text-sm text-white/70">Both tracks load fully before playback so they stay in sync.</p>
          </div>
        ) : snap.transport === 'error' ? (
          <p role="alert" className="max-w-lg text-center text-lg text-[#ffd6dc]">{snap.error}</p>
        ) : mode === 'lines' ? (
          <Lyrics lines={lyrics!.lines} wordMode={wordMode} clock={clock} playing={playing} reduced={reduced} ended={snap.transport === 'ended'} />
        ) : mode === 'plain' ? (
          <div className="scroll-thin max-h-full w-full max-w-3xl overflow-y-auto rounded-xl bg-black/25 p-5 text-center">
            <p className="mb-3 text-sm text-gold">This song has lyrics without timing, so they cannot follow the music.</p>
            <p className="whitespace-pre-wrap text-[clamp(1.1rem,2.4cqw,1.7rem)] leading-relaxed" tabIndex={0}>{lyrics!.plain}</p>
          </div>
        ) : (
          <div className="text-center">
            <p className="font-display text-[clamp(1.6rem,4cqw,3rem)] font-bold">No lyrics for this song</p>
            <p className="mt-1 text-white/70">The music plays normally. {canControl ? 'Open the song in the library to pick a lyric match.' : ''}</p>
          </div>
        )}
      </div>

      {notice && <div className="px-4 pb-2">{notice}</div>}

      <footer className="px-[3cqw] pb-[1.6cqw] max-sm:px-4 max-sm:pb-3">
        {lyrics?.attribution && loaded && (
          <p className={`mb-1 truncate text-center text-white/55 ${fullscreen ? 'text-[clamp(.8rem,1.3cqw,1.3rem)]' : 'text-xs'}`}>{lyrics.attribution}</p>
        )}
        {loaded && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-black/30 px-3 py-2 backdrop-blur-sm sm:flex-nowrap sm:gap-3">
            <Button
              className="btn btn-primary btn-icon h-11 w-11 rounded-full" onClick={onPlayPause}
              disabled={!canControl || !live || snap.transport === 'loading'}
              aria-label={playing ? 'Pause' : snap.transport === 'ended' ? 'Play again' : 'Play'}
            >
              {playing ? <Pause size={20} /> : <Play size={20} />}
            </Button>
            <button className="btn btn-icon" onClick={() => engine.seek(engine.getPosition() - 10)} disabled={!canSeek} aria-label="Back 10 seconds"><SkipBack size={16} /></button>
            <SeekBar
              engine={engine} playing={playing} scrub={scrub} duration={snap.duration} disabled={!canSeek} onScrub={setScrub}
              timer={fullscreen ? 'text-[clamp(1rem,1.8cqw,1.6rem)]' : 'text-sm'}
            />
            <button className="btn btn-icon" onClick={() => engine.seek(engine.getPosition() + 10)} disabled={!canSeek} aria-label="Forward 10 seconds"><SkipForward size={16} /></button>
            <button className="btn btn-icon" onClick={() => setShowTiming((v) => !v)} aria-expanded={showTiming} aria-label="Lyric timing" title="Lyric timing"><SlidersHorizontal size={16} /></button>
            {canControl && <button className="btn btn-icon" onClick={onStop} aria-label="End song" title="End song"><Square size={16} /></button>}
          </div>
        )}
        {loaded && showTiming && (
          <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl bg-black/30 px-3 py-2 text-sm">
            <span className="shrink-0">Lyric timing</span>
            <Slider
              className="flex-1" label="Lyric timing offset in seconds" value={offset} min={-5} max={5} step={0.1} disabled={!canControl}
              valueText={offset === 0 ? 'No offset' : `${Math.abs(offset).toFixed(1)} seconds ${offset > 0 ? 'later' : 'earlier'}`}
              onChange={onOffset} color="#63decb"
            />
            <span className="w-24 text-right tabular-nums">{offset === 0 ? 'In sync' : `${offset > 0 ? '+' : '−'}${Math.abs(offset).toFixed(1)}s ${offset > 0 ? 'later' : 'earlier'}`}</span>
            <button className="btn btn-sm" onClick={() => onOffset(0)} disabled={!canControl || offset === 0}>Reset</button>
          </div>
        )}
        {loaded && fullscreen && (
          <div className="mt-2 grid gap-x-4 gap-y-1 rounded-xl bg-black/30 px-3 py-2 text-[clamp(.8rem,1.3cqw,1.2rem)] sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label="Quick mixer">
            {([
              ['Backing', snap.backingGain, 1.5, '#7556e8', (v: number) => engine.setBackingGain(v), false, snap.backingMuted, (m: boolean) => engine.setBackingMuted(m)],
              ['Guide vocal', snap.guideGain, 1.5, '#ffd465', (v: number) => engine.setGuideGain(v), false, snap.guideMuted, (m: boolean) => engine.setGuideMuted(m)],
              ['Mic 1', snap.mics[0].gain, 2, '#ff688b', (v: number) => engine.setMicGain(0, v), snap.mics[0].status !== 'on', snap.mics[0].muted, (m: boolean) => engine.setMicMuted(0, m)],
              ['Mic 2', snap.mics[1].gain, 2, '#63decb', (v: number) => engine.setMicGain(1, v), snap.mics[1].status !== 'on', snap.mics[1].muted, (m: boolean) => engine.setMicMuted(1, m)],
            ] as const).map(([name, val, max, color, set, off, muted, mute]) => (
              <div key={name} className="flex items-center gap-2">
                <button
                  className={`btn btn-icon btn-sm shrink-0 ${muted ? 'btn-danger' : ''}`} onClick={() => mute(!muted)} disabled={off}
                  aria-pressed={muted} aria-label={`Mute ${name.toLowerCase()}`}
                >
                  {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                </button>
                <span className="w-[5.5em] shrink-0">{name}</span>
                <Slider
                  className={muted ? 'opacity-50' : ''} label={`${name} volume`} value={val} max={max} step={0.01} onChange={set} color={color} disabled={off}
                  valueText={`${Math.round(val * 100)} percent${muted ? ', muted' : ''}`}
                />
                <span className="w-[3.4em] text-right tabular-nums text-white/70">{muted ? 'Muted' : `${Math.round(val * 100)}%`}</span>
              </div>
            ))}
          </div>
        )}
        {nextUp && (
          <p className={`mt-2 truncate text-center text-white/75 ${fullscreen ? 'text-[clamp(1rem,2cqw,2rem)]' : 'text-[clamp(.8rem,1.4cqw,1rem)]'}`}>
            <span className="font-bold text-mint">Up next:</span> {nextUp}
            {snap.transport === 'ended' && ' · waiting for the host to start it'}
          </p>
        )}
      </footer>
    </section>
  );
}

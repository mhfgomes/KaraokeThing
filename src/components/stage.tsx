'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Maximize2, Minimize2, Pause, Play, Square, SlidersHorizontal, SkipBack, SkipForward } from 'lucide-react';
import type { AudioEngine, EngineSnapshot } from '@/lib/audio-engine';
import { formatTime } from '@/lib/client-api';
import type { LyricLine, Track } from '@/lib/types';
import { currentLyricIndex } from '@/lib/lyric-timing';
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

function WordLine({ line, t, reduced }: { line: LyricLine; t: number; reduced: boolean }) {
  const words = line.words!;
  return (
    <>
      {words.map((w, i) => {
        const end = w.end ?? words[i + 1]?.start ?? line.end ?? w.start + 0.5;
        const raw = end > w.start ? (t - w.start) / (end - w.start) : t >= w.start ? 1 : 0;
        const p = Math.min(1, Math.max(0, raw));
        const sep = i < words.length - 1 ? ' ' : '';
        if (p >= 1) return <span key={i} className="w w-done">{w.text + sep}</span>;
        if (p <= 0) return <span key={i} className="w">{w.text + sep}</span>;
        const pct = reduced ? 0 : p * 100;
        return <span key={i} className="w w-fill" style={{ ['--p' as string]: `${pct}%` }}>{w.text + sep}</span>;
      })}
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
  const [, tick] = useState(0);
  const [showTiming, setShowTiming] = useState(false);
  const playing = snap.transport === 'playing';

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => { tick((n) => (n + 1) % 1e9); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const pos = engine.getPosition();
  const t = pos - offset;
  const lyrics = track?.lyrics;
  const loaded = track && snap.trackId === track.id && snap.transport !== 'idle';
  const hasLines = !!lyrics && (lyrics.kind === 'word' || lyrics.kind === 'line') && lyrics.lines.length > 0;
  const mode: 'lines' | 'plain' | 'missing' = hasLines ? 'lines' : lyrics && lyrics.plain.trim() ? 'plain' : 'missing';
  const idx = useMemo(() => (hasLines ? currentLyricIndex(lyrics!.lines, t) : -1), [hasLines, lyrics, t]);

  const toggleFs = () => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => undefined);
  };

  const live = !!loaded && snap.transport !== 'error';
  const canSeek = canControl && live && snap.transport !== 'loading';
  const wordMode = lyrics?.kind === 'word';

  const renderLines = () => {
    const lines = lyrics!.lines;
    const prev = idx > 0 ? lines[idx - 1] : null;
    const cur = idx >= 0 ? lines[idx] : null;
    const upcoming = lines.slice(idx + 1, idx + 3);
    return (
      <div className="flex w-full flex-col items-center gap-[2.2cqw]" aria-live="off">
        <p className="lyric lyric-prev min-h-[1.2em]" aria-hidden>{prev?.text ?? ' '}</p>
        <p key={idx} className="lyric lyric-now lyric-line-enter min-h-[1.1em]">
          {cur
            ? wordMode && cur.words?.length
              ? <WordLine line={cur} t={t} reduced={reduced} />
              : <span className="line-now">{cur.text}</span>
            : <span className="text-white/60 text-[0.5em]">{lines[0] && snap.transport !== 'ended' ? 'Get ready…' : ''}</span>}
        </p>
        <div className="flex flex-col items-center gap-[1.2cqw]">
          {upcoming.map((l, i) => <p key={idx + 1 + i} className="lyric lyric-next">{l.text}</p>)}
        </div>
      </div>
    );
  };

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
          <Button className="btn btn-icon" onClick={toggleFs} aria-label={fullscreen ? 'Leave full screen' : 'Show stage full screen'} aria-pressed={fullscreen}>
            {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-[4cqw] py-4 max-sm:px-3">
        {!loaded ? (
          <div className="w-full min-w-0 max-w-xl text-center">{idle}</div>
        ) : snap.transport === 'loading' ? (
          <div className="w-full max-w-md text-center" role="status">
            <p className="font-display text-3xl font-bold">{snap.loadStage || 'Loading'}</p>
            <div className="meter mt-4 h-2"><i style={{ width: `${Math.round(snap.loadProgress * 100)}%` }} /></div>
            <p className="mt-2 text-sm text-white/70">Both tracks load fully before playback so they stay in sync.</p>
          </div>
        ) : snap.transport === 'error' ? (
          <p role="alert" className="max-w-lg text-center text-lg text-[#ffd6dc]">{snap.error}</p>
        ) : mode === 'lines' ? (
          renderLines()
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
          <p className="mb-1 truncate text-center text-xs text-white/55">{lyrics.attribution}</p>
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
            <button className="btn btn-icon" onClick={() => engine.seek(pos - 10)} disabled={!canSeek} aria-label="Back 10 seconds"><SkipBack size={16} /></button>
            <span className="w-12 text-right font-mono text-sm tabular-nums" aria-hidden>{formatTime(pos)}</span>
            <Slider
              className="order-first basis-full sm:order-none sm:basis-auto sm:flex-1" label="Seek position" value={Math.min(pos, snap.duration || 1)} max={snap.duration || 1} step={0.1}
              disabled={!canSeek} valueText={`${formatTime(pos)} of ${formatTime(snap.duration)}`} color="#ffd465"
              onChange={(v) => engine.seek(v)}
            />
            <span className="w-12 font-mono text-sm tabular-nums text-white/70" aria-hidden>{formatTime(snap.duration)}</span>
            <button className="btn btn-icon" onClick={() => engine.seek(pos + 10)} disabled={!canSeek} aria-label="Forward 10 seconds"><SkipForward size={16} /></button>
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
          <div className="mt-2 grid gap-x-4 gap-y-1 rounded-xl bg-black/30 px-3 py-2 text-xs sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label="Quick mixer">
            {([
              ['Backing', snap.backingGain, 1.5, '#7556e8', (v: number) => engine.setBackingGain(v), false],
              ['Guide vocal', snap.guideGain, 1.5, '#ffd465', (v: number) => engine.setGuideGain(v), false],
              ['Mic 1', snap.mics[0].gain, 2, '#ff688b', (v: number) => engine.setMicGain(0, v), snap.mics[0].status !== 'on'],
              ['Mic 2', snap.mics[1].gain, 2, '#63decb', (v: number) => engine.setMicGain(1, v), snap.mics[1].status !== 'on'],
            ] as const).map(([name, val, max, color, set, off]) => (
              <div key={name} className="flex items-center gap-2">
                <span className="w-16 shrink-0">{name}</span>
                <Slider label={`${name} volume`} value={val} max={max} step={0.01} onChange={set} color={color} disabled={off} valueText={`${Math.round(val * 100)} percent`} />
                <span className="w-9 text-right tabular-nums text-white/70">{Math.round(val * 100)}%</span>
              </div>
            ))}
          </div>
        )}
        {nextUp && (
          <p className="mt-2 truncate text-center text-[clamp(.8rem,1.4cqw,1rem)] text-white/75">
            <span className="font-bold text-mint">Up next:</span> {nextUp}
            {snap.transport === 'ended' && ' · waiting for the host to start it'}
          </p>
        )}
      </footer>
    </section>
  );
}

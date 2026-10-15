'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Copy, Headphones, Mic, MicOff, MonitorPlay, Pause, Play, RefreshCw, SkipBack, SkipForward, SlidersHorizontal, Square, Volume2, VolumeX } from 'lucide-react';
import { fetchStage, formatTime, stageCommand, type StageCommand, type StageMix } from '@/lib/client-api';
import type { StageAdminState, StageDesired, StageMicConfig, StageMicMode, Track } from '@/lib/types';
import { Lyrics, useReducedMotion } from './stage';
import { ErrorNote, Slider } from './ui-bits';

const POLL_MS = 1000;
/** Local slider values win over polled ones for this long, so a drag isn't yanked back mid-move. */
const EDIT_HOLD_MS = 2000;
const SEND_MS = 120;

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export interface StageRemote {
  stage: StageAdminState | null;
  receivedAt: number;
  error: string;
  send: (command: StageCommand) => Promise<boolean>;
}

/** Polls the stage display's state while the host is signed in. */
export function useStageRemote(admin: boolean): StageRemote {
  const [stage, setStage] = useState<StageAdminState | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!admin) return;
    let alive = true;
    let busy = false;
    const run = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const s = await fetchStage();
        if (alive) { setStage(s); setReceivedAt(Date.now()); }
      } catch { /* the main poll already reports a lost host */ }
      busy = false;
    };
    void run();
    const timer = setInterval(run, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [admin]);

  const send = useCallback(async (command: StageCommand) => {
    try {
      const s = await stageCommand(command);
      setStage(s); setReceivedAt(Date.now()); setError('');
      return true;
    } catch (e) { setError(msg(e)); return false; }
  }, []);

  return { stage: admin ? stage : null, receivedAt, error, send };
}

/** Where the display most likely is right now, from its last report. */
export function stagePosition(remote: StageRemote): number {
  const r = remote.stage?.report;
  if (!r || r.trackId !== remote.stage?.desired.trackId) return 0;
  if (r.transport !== 'playing') return r.position;
  const age = (remote.stage!.now - r.at + Date.now() - remote.receivedAt) / 1000;
  return Math.min(r.duration || Infinity, r.position + Math.max(0, age));
}

function useTick(active: boolean, ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

const joinMix = (a: StageMix, b: StageMix): StageMix => {
  const out: StageMix = { ...a, ...b };
  if (a.mics || b.mics) out.mics = [{ ...a.mics?.[0], ...b.mics?.[0] }, { ...a.mics?.[1], ...b.mics?.[1] }];
  return out;
};

/** Mixer values with optimistic local edits, sent to the display in small batches. */
function useStageMix(remote: StageRemote) {
  const [local, setLocal] = useState<StageMix>({});
  const pending = useRef<StageMix>({});
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { for (const t of [sendTimer.current, holdTimer.current]) if (t) clearTimeout(t); }, []);

  const base = remote.stage?.desired;
  const set = (patch: StageMix) => {
    setLocal((l) => joinMix(l, patch));
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => setLocal({}), EDIT_HOLD_MS);
    pending.current = joinMix(pending.current, patch);
    sendTimer.current ??= setTimeout(() => {
      sendTimer.current = null;
      const mix = pending.current;
      pending.current = {};
      void remote.send({ action: 'mix', mix });
    }, SEND_MS);
  };
  if (!base) return { desired: null, set };
  const { mics, ...rest } = local;
  const desired: StageDesired = { ...base, ...rest, mics: mics ? [{ ...base.mics[0], ...mics[0] }, { ...base.mics[1], ...mics[1] }] : base.mics };
  return { desired, set };
}

const micPatch = (i: 0 | 1, p: Partial<StageMicConfig>): StageMix => ({ mics: i === 0 ? [p, {}] : [{}, p] });

export function OutputToggle({ output, onOutput, connected }: { output: 'browser' | 'display'; onOutput: (o: 'browser' | 'display') => void; connected: boolean }) {
  return (
    <div role="radiogroup" aria-label="Where songs play" className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Play songs on</span>
      <div className="flex gap-1 rounded-xl bg-black/30 p-1">
        {([['browser', 'This browser'], ['display', 'Stage display']] as const).map(([id, label]) => (
          <button
            key={id} role="radio" aria-checked={output === id} onClick={() => onOutput(id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1 font-bold ${output === id ? 'bg-violet text-white' : 'text-white/75 hover:bg-white/10'}`}
          >
            {id === 'display' && <span className={`size-2 rounded-full ${connected ? 'bg-mint' : 'bg-white/30'}`} aria-hidden />}
            {label}
            {id === 'display' && <span className="sr-only">{connected ? ' (connected)' : ' (not connected)'}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function RemoteStage({ remote, track, offset, onOffset, nextUp, idle, notice }: {
  remote: StageRemote; track: Track | null; offset: number; onOffset: (v: number) => void; nextUp: string | null; idle: ReactNode; notice?: ReactNode;
}) {
  const s = remote.stage;
  const r = s?.report;
  const d = s?.desired;
  const reduced = useReducedMotion();
  const [scrub, setScrub] = useState<number | null>(null);
  const [showTiming, setShowTiming] = useState(false);
  const loaded = !!d?.trackId && r?.trackId === d.trackId;
  const transport = loaded ? r!.transport : d?.trackId ? 'loading' : 'idle';
  const playing = transport === 'playing';
  useTick(playing, 250);
  const pos = scrub ?? stagePosition(remote);
  const duration = loaded ? r!.duration : track?.duration ?? 0;
  const lyrics = track?.lyrics;
  const hasLines = !!lyrics && (lyrics.kind === 'word' || lyrics.kind === 'line') && lyrics.lines.length > 0;
  const live = loaded && ['ready', 'playing', 'paused', 'ended'].includes(transport);
  const seek = (v: number) => void remote.send({ action: 'seek', position: Math.max(0, Math.min(v, Math.max(0, duration - 0.05))) });

  let center: ReactNode;
  if (!s?.connected) {
    center = (
      <div className="max-w-lg text-center">
        <MonitorPlay size={40} className="mx-auto mb-3 text-violet-soft" aria-hidden />
        <p className="font-display text-4xl font-bold">Stage display offline</p>
        <p className="mt-2 text-white/75">Start the KaraokeThing Stage app on the main screen, or pair one from the <b>Stage</b> tab. Songs play there once it connects.</p>
      </div>
    );
  } else if (!d?.trackId || !track) center = <div className="w-full min-w-0 max-w-xl text-center">{idle}</div>;
  else if (transport === 'loading') {
    const pct = Math.round((loaded ? r!.loadProgress : 0) * 100);
    center = (
      <div className="w-full max-w-md text-center">
        <p className="font-display text-3xl font-bold" role="status">Loading on the stage display</p>
        <div className="meter mt-4 h-2" role="progressbar" aria-label="Loading song" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
      </div>
    );
  } else if (transport === 'error') center = <p role="alert" className="max-w-lg text-center text-lg text-[#ffd6dc]">The stage display could not play this song: {r?.error}</p>;
  else if (hasLines) center = <Lyrics key={track.id} lines={lyrics!.lines} wordMode={lyrics!.kind === 'word'} clock={() => (scrub ?? stagePosition(remote)) - offset} playing={playing} reduced={reduced} ended={transport === 'ended'} />;
  else center = <p className="text-center text-lg text-white/75">{lyrics?.plain.trim() ? 'This song has lyrics without timing; the stage display shows them in full.' : 'No lyrics for this song. The music plays normally.'}</p>;

  return (
    <section aria-label="Stage display remote" data-live={playing} className="stage flex min-h-[26rem] flex-1 flex-col rounded-2xl border border-white/10 lg:min-h-0">
      <div className="beam beam-a" aria-hidden />
      <div className="beam beam-b" aria-hidden />
      <div className="beam beam-c" aria-hidden />
      <header className="flex items-start justify-between gap-3 px-[3cqw] pt-[2.2cqw] max-sm:px-4 max-sm:pt-3">
        <div className="min-w-0">
          {track && d?.trackId ? (
            <>
              <h2 className="truncate font-display text-[clamp(1.4rem,3.2cqw,2.6rem)] font-bold leading-none tracking-wide">{track.title}</h2>
              <p className="mt-1 truncate text-[clamp(.85rem,1.6cqw,1.15rem)] text-white/70">{track.artist}</p>
            </>
          ) : <p className="font-display text-[clamp(1.2rem,2.6cqw,2rem)] font-bold tracking-wide text-white/70">Stage display</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {d?.singer && d.trackId && <span className="max-w-[40cqw] truncate rounded-full bg-coral px-3.5 py-1 font-display text-[clamp(1rem,2cqw,1.5rem)] font-bold text-plum-950">{d.singer}</span>}
          <span className={`chip ${s?.connected ? 'chip-mint' : 'chip-dim'}`}>{s?.connected ? 'Display connected' : 'Display offline'}</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-[4cqw] py-4 max-sm:px-3">{center}</div>

      {(notice || remote.error || r?.soundBlocked) && (
        <div className="space-y-2 px-4 pb-2">
          {notice}
          {remote.error && <ErrorNote>{remote.error}</ErrorNote>}
          {r?.soundBlocked && s?.connected && <ErrorNote tone="warn">The browser on the stage display is blocking sound. Click its screen once, or use the KaraokeThing Stage app, which doesn’t need this.</ErrorNote>}
        </div>
      )}

      <footer className="px-[3cqw] pb-[1.6cqw] max-sm:px-4 max-sm:pb-3">
        {d?.trackId && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-black/30 px-3 py-2 backdrop-blur-sm sm:flex-nowrap sm:gap-3">
            <button
              className="btn btn-primary btn-icon h-11 w-11 rounded-full" disabled={!live}
              onClick={() => void remote.send({ action: playing ? 'pause' : 'play' })}
              aria-label={playing ? 'Pause' : transport === 'ended' ? 'Play again' : 'Play'}
            >{playing ? <Pause size={20} /> : <Play size={20} />}</button>
            <button className="btn btn-icon" onClick={() => seek(pos - 10)} disabled={!live} aria-label="Back 10 seconds"><SkipBack size={16} /></button>
            <div className="order-first flex basis-full items-center gap-2 sm:contents">
              <span className="w-[3.4em] text-right font-mono text-sm tabular-nums" aria-hidden>{formatTime(pos)}</span>
              <Slider
                className="flex-1" label="Seek position" value={Math.min(pos, duration || 1)} max={duration || 1} step={0.1} disabled={!live} color="#ffd465"
                valueText={`${formatTime(pos)} of ${formatTime(duration)}`} onChange={setScrub} onCommit={(v) => { setScrub(null); seek(v); }}
              />
              <span className="w-[3.4em] font-mono text-sm tabular-nums text-white/70" aria-hidden>{formatTime(duration)}</span>
            </div>
            <button className="btn btn-icon" onClick={() => seek(pos + 10)} disabled={!live} aria-label="Forward 10 seconds"><SkipForward size={16} /></button>
            <button className="btn btn-icon" onClick={() => setShowTiming((v) => !v)} aria-expanded={showTiming} aria-label="Lyric timing" title="Lyric timing"><SlidersHorizontal size={16} /></button>
            <button className="btn btn-icon" onClick={() => void remote.send({ action: 'stop' })} aria-label="End song" title="End song"><Square size={16} /></button>
          </div>
        )}
        {d?.trackId && showTiming && (
          <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl bg-black/30 px-3 py-2 text-sm">
            <span className="shrink-0">Lyric timing</span>
            <Slider
              className="flex-1" label="Lyric timing offset in seconds" value={offset} min={-5} max={5} step={0.1} onChange={onOffset} color="#63decb"
              valueText={offset === 0 ? 'No offset' : `${Math.abs(offset).toFixed(1)} seconds ${offset > 0 ? 'later' : 'earlier'}`}
            />
            <span className="w-24 text-right tabular-nums">{offset === 0 ? 'In sync' : `${offset > 0 ? '+' : '−'}${Math.abs(offset).toFixed(1)}s ${offset > 0 ? 'later' : 'earlier'}`}</span>
            <button className="btn btn-sm" onClick={() => onOffset(0)} disabled={offset === 0}>Reset</button>
          </div>
        )}
        {nextUp && (
          <p className="mt-2 truncate text-center text-[clamp(.8rem,1.4cqw,1rem)] text-white/75">
            <span className="font-bold text-mint">Up next:</span> {nextUp}{transport === 'ended' && ' · waiting for you to start it'}
          </p>
        )}
      </footer>
    </section>
  );
}

const MODES: { id: StageMicMode; label: string }[] = [
  { id: 'mix', label: 'Mix all channels' }, { id: 'left', label: 'Left channel only' }, { id: 'right', label: 'Right channel only' }, { id: 'stereo', label: 'Stereo (both)' },
];

function Strip({ title, accent, children }: { title: string; accent: string; children: ReactNode }) {
  return (
    <fieldset className="panel min-w-0 p-3" style={{ borderTop: `3px solid ${accent}` }}>
      <legend className="sr-only">{title}</legend>
      <p className="mb-2 font-display text-lg font-bold tracking-wide" aria-hidden>{title}</p>
      {children}
    </fieldset>
  );
}

function Level({ title, accent, gain, max, muted, onGain, onMute, disabled }: {
  title: string; accent: string; gain: number; max: number; muted: boolean; onGain: (v: number) => void; onMute: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <button className={`btn btn-icon btn-sm ${muted ? 'btn-danger' : ''}`} onClick={() => onMute(!muted)} aria-pressed={muted} aria-label={`Mute ${title.toLowerCase()}`} disabled={disabled}>
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
      <Slider label={`${title} volume`} value={gain} max={max} step={0.01} onChange={onGain} color={accent} disabled={disabled} valueText={`${Math.round(gain * 100)} percent`} />
      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(gain * 100)}%</span>
    </div>
  );
}

/** Mixer for the stage display; every change is sent to the display through the host. */
export function RemoteMixer({ remote }: { remote: StageRemote }) {
  const { desired: d, set } = useStageMix(remote);
  const r = remote.stage?.report;
  if (!d) return null;
  const loaded = !!d.trackId && r?.trackId === d.trackId && r.transport !== 'loading';
  return (
    <section aria-label="Stage display mixer" className="space-y-3">
      {!remote.stage?.connected && <ErrorNote tone="warn">The stage display is offline. Changes are saved and apply when it reconnects.</ErrorNote>}
      {r?.micSupported === false && (
        <ErrorNote tone="warn">The stage display can’t use microphones. Browsers only allow them on secure pages; the KaraokeThing Stage app allows them for your host.</ErrorNote>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Strip title="Backing" accent="#7556e8">
          <Level title="Backing" accent="#7556e8" gain={d.backingGain} max={1.5} muted={d.backingMuted} onGain={(v) => set({ backingGain: v })} onMute={(v) => set({ backingMuted: v })} />
        </Strip>
        <Strip title="Guide vocal" accent="#ffd465">
          <Level title="Guide vocal" accent="#ffd465" gain={d.guideGain} max={1.5} muted={d.guideMuted} onGain={(v) => set({ guideGain: v })} onMute={(v) => set({ guideMuted: v })} />
          <p className="mt-1 text-xs text-muted-foreground">{loaded && !r?.hasGuide ? 'This song has no guide vocal.' : 'Raise it to hear the original singer.'}</p>
        </Strip>
        {([0, 1] as const).map((i) => {
          const m = d.mics[i];
          const st = r?.mics[i];
          const devices = r?.devices ?? [];
          const known = !m.deviceId || devices.some((x) => x.deviceId === m.deviceId);
          const on = st?.status === 'on';
          const n = i + 1;
          const accent = i === 0 ? '#ff688b' : '#63decb';
          return (
            <Strip key={i} title={`Microphone ${n}`} accent={accent}>
              <div className="space-y-2">
                <div>
                  <label className="lbl" htmlFor={`smic${n}-dev`}>Input on the stage computer<span className="sr-only"> for microphone {n}</span></label>
                  <select id={`smic${n}-dev`} className="field" value={m.deviceId} onChange={(e) => set(micPatch(i, { deviceId: e.target.value }))}>
                    <option value="">System default input</option>
                    {!known && <option value={m.deviceId}>Previously selected input (not found)</option>}
                    {devices.map((x) => <option key={x.deviceId} value={x.deviceId}>{x.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="lbl" htmlFor={`smic${n}-mode`}>Channels<span className="sr-only"> for microphone {n}</span></label>
                  <select id={`smic${n}-mode`} className="field" value={m.mode} onChange={(e) => set(micPatch(i, { mode: e.target.value as StageMicMode }))}>
                    {MODES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button className={`btn btn-sm ${m.enabled ? '' : 'btn-violet'}`} onClick={() => set(micPatch(i, { enabled: !m.enabled }))} disabled={r?.micSupported === false && !m.enabled}>
                    {m.enabled ? <><MicOff size={14} /> Turn off</> : <><Mic size={14} /> Turn on</>}
                  </button>
                  <button className={`btn btn-sm ${m.monitor ? 'btn-primary' : ''}`} aria-pressed={m.monitor} aria-label={`Hear microphone ${n}`} onClick={() => set(micPatch(i, { monitor: !m.monitor }))}>
                    <Headphones size={14} /> Hear it: {m.monitor ? 'on' : 'off'}
                  </button>
                </div>
                <Level title={`Microphone ${n}`} accent={accent} gain={m.gain} max={2} muted={m.muted} onGain={(v) => set(micPatch(i, { gain: v }))} onMute={(v) => set(micPatch(i, { muted: v }))} />
                <p className="truncate text-xs text-muted-foreground">
                  {!m.enabled ? 'Off' : st?.status === 'starting' ? 'Starting…' : on ? `On${st?.label ? `: ${st.label}` : ''}` : st?.status === 'error' ? '' : 'Waiting for the display'}
                </p>
                {m.enabled && st?.status === 'error' && <ErrorNote>{st.error} Turn it off and on to try again.</ErrorNote>}
              </div>
            </Strip>
          );
        })}
      </div>
      {d.mics.some((m) => m.enabled && m.monitor) && (
        <ErrorNote tone="warn">Hearing a microphone through the stage speakers can cause feedback. Keep the volume low, or monitor directly on an audio interface.</ErrorNote>
      )}
    </section>
  );
}

/** Pairing and display options for the stage display. */
export function StagePanel({ remote }: { remote: StageRemote }) {
  const s = remote.stage;
  const { desired: d, set } = useStageMix(remote);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const link = s ? `${typeof window === 'undefined' ? '' : window.location.origin}/stage#key=${s.key}` : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the link stays selectable */ }
  };
  if (!s || !d) return <p className="text-sm text-muted-foreground" role="status">Loading stage settings…</p>;
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
      <section aria-labelledby="st-pair" className="space-y-2">
        <h3 id="st-pair" className="font-display text-xl font-bold">Stage display</h3>
        <p className="flex items-center gap-2 text-sm">
          <span className={`size-2.5 rounded-full ${s.connected ? 'bg-mint' : 'bg-white/30'}`} aria-hidden />
          {s.connected ? 'Connected. Songs you start play there.' : s.report ? `Offline since ${new Date(s.report.at).toLocaleTimeString()}.` : 'No display has connected yet.'}
        </p>
        <p className="text-sm text-muted-foreground">
          The stage display shows only lyrics and plays the sound on the main screen. Install the KaraokeThing Stage app on that computer and paste this link when it asks, or open the link in a browser there.
        </p>
        <label className="lbl" htmlFor="st-link">Stage link</label>
        <div className="flex gap-2">
          <input id="st-link" className="field font-mono text-xs" readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn btn-sm shrink-0" onClick={() => void copy()}><Copy size={13} /> {copied ? 'Copied' : 'Copy'}</button>
        </div>
        <p className="text-xs text-muted-foreground">Anyone with this link can show the stage display, but can’t control anything.</p>
        {confirmRotate ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>Paired displays will need the new link.</span>
            <button className="btn btn-sm btn-danger" onClick={() => { setConfirmRotate(false); void remote.send({ action: 'rotateKey' }); }}>Make new link</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setConfirmRotate(false)}>Cancel</button>
          </div>
        ) : <button className="btn btn-sm" onClick={() => setConfirmRotate(true)}><RefreshCw size={13} /> Make a new link</button>}
      </section>

      <section aria-labelledby="st-show" className="space-y-2 border-t border-white/10 pt-4">
        <h3 id="st-show" className="font-display text-xl font-bold">On screen</h3>
        {([['showSinger', 'Show the singer’s name'], ['showNextUp', 'Show who’s up next']] as const).map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[#7556e8]" checked={d[k]} onChange={(e) => set({ [k]: e.target.checked })} />
            {label}
          </label>
        ))}
      </section>
      {remote.error && <ErrorNote>{remote.error}</ErrorNote>}
    </div>
  );
}

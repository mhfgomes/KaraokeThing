'use client';

import { useEffect, useRef, useState } from 'react';
import { Headphones, Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import type { AudioEngine, ChannelMode, EngineSnapshot, MicSnapshot } from '@/lib/audio-engine';
import { ErrorNote, Slider } from './ui-bits';

function Meter({ engine, index, active }: { engine: AudioEngine; index: 0 | 1; active: boolean }) {
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active) { if (bar.current) bar.current.style.width = '0%'; return; }
    let raf = 0;
    const loop = () => {
      const lvl = Math.min(1, engine.getMicLevel(index) * 4);
      if (bar.current) bar.current.style.width = `${Math.round(lvl * 100)}%`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, index, active]);
  return <div className="meter" role="img" aria-label={`Microphone ${index + 1} input level`}><i ref={bar} /></div>;
}

const MODES: { id: ChannelMode; label: string }[] = [
  { id: 'mix', label: 'Mix all channels' },
  { id: 'left', label: 'Left channel only' },
  { id: 'right', label: 'Right channel only' },
  { id: 'stereo', label: 'Stereo (both)' },
];

function Strip({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <fieldset className="panel min-w-0 p-3" style={{ borderTop: `3px solid ${accent}` }}>
      <legend className="sr-only">{title}</legend>
      <p className="mb-2 font-display text-lg font-bold tracking-wide" aria-hidden>{title}</p>
      {children}
    </fieldset>
  );
}

function StemStrip({ title, accent, gain, muted, onGain, onMute, note }: {
  title: string; accent: string; gain: number; muted: boolean; onGain: (v: number) => void; onMute: (v: boolean) => void; note?: string;
}) {
  return (
    <Strip title={title} accent={accent}>
      <div className="flex items-center gap-2">
        <button className={`btn btn-icon btn-sm ${muted ? 'btn-danger' : ''}`} onClick={() => onMute(!muted)} aria-pressed={muted} aria-label={`${muted ? 'Unmute' : 'Mute'} ${title.toLowerCase()}`}>
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
        <Slider label={`${title} volume`} value={gain} max={1.5} step={0.01} onChange={onGain} color={accent} valueText={`${Math.round(gain * 100)} percent`} />
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(gain * 100)}%</span>
      </div>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
    </Strip>
  );
}

function MicStrip({ engine, snap, index, accent }: { engine: AudioEngine; snap: EngineSnapshot; index: 0 | 1; accent: string }) {
  const m: MicSnapshot = snap.mics[index];
  const n = index + 1;
  const on = m.status === 'on';
  const idPrefix = `mic${n}`;
  const knownDevice = !m.deviceId || snap.devices.some((d) => d.deviceId === m.deviceId);
  return (
    <Strip title={`Microphone ${n}`} accent={accent}>
      <div className="space-y-2">
        <div>
          <label className="lbl" htmlFor={`${idPrefix}-dev`}>Input device</label>
          <select id={`${idPrefix}-dev`} className="field" value={m.deviceId} onChange={(e) => engine.setMicDevice(index, e.target.value)} disabled={m.status === 'starting'}>
            <option value="">System default input</option>
            {!knownDevice && <option value={m.deviceId}>Previously selected input (not found)</option>}
            {snap.devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
          </select>
        </div>
        <div>
          <label className="lbl" htmlFor={`${idPrefix}-mode`}>Channels</label>
          <select id={`${idPrefix}-mode`} className="field" value={m.mode} onChange={(e) => engine.setMicMode(index, e.target.value as ChannelMode)}>
            {MODES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          {on && m.channels !== null && <p className="mt-1 text-xs text-muted-foreground">Browser reports {m.channels} channel{m.channels === 1 ? '' : 's'} for this input.{m.channels < 2 && m.mode !== 'mix' && m.mode !== 'stereo' ? ' Left/right choice has no effect on a single-channel input.' : ''}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {on || m.status === 'starting' ? (
            <button className="btn btn-sm" onClick={() => engine.disableMic(index)} disabled={m.status === 'starting'}><MicOff size={14} /> Turn off</button>
          ) : (
            <button className="btn btn-violet btn-sm" onClick={() => void engine.enableMic(index)} disabled={snap.micSupported === false}>
              <Mic size={14} /> {m.status === 'error' ? 'Try again' : 'Turn on'}
            </button>
          )}
          <button className="btn btn-sm" aria-pressed={m.muted} onClick={() => engine.setMicMuted(index, !m.muted)} disabled={!on}>
            {m.muted ? <VolumeX size={14} /> : <Volume2 size={14} />} {m.muted ? 'Muted' : 'Mute'}
          </button>
          <button className={`btn btn-sm ${m.monitor ? 'btn-primary' : ''}`} aria-pressed={m.monitor} onClick={() => engine.setMicMonitor(index, !m.monitor)} disabled={!on}>
            <Headphones size={14} /> Hear it: {m.monitor ? 'on' : 'off'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Slider label={`Microphone ${n} volume`} value={m.gain} max={2} step={0.01} onChange={(v) => engine.setMicGain(index, v)} color={accent} disabled={!on} valueText={`${Math.round(m.gain * 100)} percent`} />
          <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(m.gain * 100)}%</span>
        </div>
        <Meter engine={engine} index={index} active={on} />
        {on && m.label && <p className="truncate text-xs text-muted-foreground" title={m.label}>Using {m.label}</p>}
        {m.status === 'error' && <ErrorNote>{m.error}</ErrorNote>}
      </div>
    </Strip>
  );
}

export function Mixer({ engine, snap }: { engine: AudioEngine; snap: EngineSnapshot }) {
  const [help, setHelp] = useState(false);
  const anyMonitor = snap.mics.some((m) => m.monitor && m.status === 'on');
  return (
    <section aria-label="Audio mixer" className="space-y-3">
      {snap.secureContext === false && (
        <ErrorNote tone="warn">
          This page is not a secure context, so the browser blocks microphones. Use http://localhost on the host computer, or serve the app over trusted HTTPS for other devices on the network. Backing and guide playback still work.
        </ErrorNote>
      )}
      {snap.secureContext && snap.micSupported === false && (
        <ErrorNote tone="warn">This browser does not expose microphone capture. Backing and guide playback still work.</ErrorNote>
      )}
      {snap.mics.some((m) => m.status === 'on') && !snap.devicesLabelled && (
        <ErrorNote tone="warn">Device names stay generic until the browser grants microphone access.</ErrorNote>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <StemStrip title="Backing" accent="#7556e8" gain={snap.backingGain} muted={snap.backingMuted} onGain={(v) => engine.setBackingGain(v)} onMute={(v) => engine.setBackingMuted(v)} />
        <StemStrip
          title="Guide vocal" accent="#ffd465" gain={snap.guideGain} muted={snap.guideMuted} onGain={(v) => engine.setGuideGain(v)} onMute={(v) => engine.setGuideMuted(v)}
          note={snap.transport !== 'idle' && snap.transport !== 'loading' && !snap.hasGuide ? 'This song has no guide vocal.' : 'Starts silent. Raise it to hear the original singer.'}
        />
        <MicStrip engine={engine} snap={snap} index={0} accent="#ff688b" />
        <MicStrip engine={engine} snap={snap} index={1} accent="#63decb" />
      </div>
      {anyMonitor && (
        <ErrorNote tone="warn">Hearing a microphone through speakers can cause feedback. Use headphones or keep the volume low. Browser monitoring adds delay; direct monitoring on an audio interface avoids it.</ErrorNote>
      )}
      <div className="text-xs text-muted-foreground">
        <button className="underline underline-offset-2" onClick={() => setHelp((v) => !v)} aria-expanded={help}>Two singers on one stereo interface</button>
        {help && (
          <p className="mt-1 max-w-2xl">
            Choose the same interface for both microphones. Set Microphone 1 to “Left channel only” and Microphone 2 to “Right channel only”. Whether a browser exposes both channels depends on the browser, operating system, and driver; this has not been validated on specific hardware, so check each meter while a singer speaks.
          </p>
        )}
        {snap.sampleRate && (
          <p className="mt-1">
            Audio engine: {Math.round(snap.sampleRate / 100) / 10} kHz, {snap.contextState}.
            {snap.baseLatency !== null && ` Browser output latency ≈ ${Math.round(((snap.outputLatency ?? 0) + snap.baseLatency) * 1000)} ms (reported, not measured end to end).`}
          </p>
        )}
      </div>
    </section>
  );
}

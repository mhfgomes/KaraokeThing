/**
 * Browser audio engine. One AudioContext clock drives both stems (backing + guide)
 * and the lyric position. Microphone inputs are optional, off by default, and are
 * only audible when the user explicitly enables monitoring.
 *
 * Nothing here has been validated against specific hardware; all failures are
 * reported to the UI rather than assumed away.
 */

export type TransportState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';
export type ChannelMode = 'mix' | 'left' | 'right' | 'stereo';
export type MicStatus = 'off' | 'starting' | 'on' | 'error';

export interface AudioInputDevice { deviceId: string; label: string }

export interface MicSnapshot {
  status: MicStatus;
  error: string | null;
  deviceId: string;
  label: string | null;
  mode: ChannelMode;
  gain: number;
  muted: boolean;
  monitor: boolean;
  channels: number | null;
}

export interface EngineSnapshot {
  transport: TransportState;
  trackId: string | null;
  duration: number;
  loadProgress: number;
  loadStage: string;
  hasGuide: boolean;
  error: string | null;
  backingGain: number;
  guideGain: number;
  backingMuted: boolean;
  guideMuted: boolean;
  mics: [MicSnapshot, MicSnapshot];
  devices: AudioInputDevice[];
  devicesLabelled: boolean;
  secureContext: boolean | null;
  micSupported: boolean | null;
  contextState: AudioContextState | 'none';
  sampleRate: number | null;
  baseLatency: number | null;
  outputLatency: number | null;
}

const makeMic = (): MicSnapshot => ({
  status: 'off', error: null, deviceId: '', label: null, mode: 'mix', gain: 1, muted: false, monitor: false, channels: null,
});

const INITIAL: EngineSnapshot = {
  transport: 'idle', trackId: null, duration: 0, loadProgress: 0, loadStage: '', hasGuide: false, error: null,
  backingGain: 0.9, guideGain: 0, backingMuted: false, guideMuted: false,
  mics: [makeMic(), makeMic()],
  devices: [], devicesLabelled: false, secureContext: null, micSupported: null,
  contextState: 'none', sampleRate: null, baseLatency: null, outputLatency: null,
};

interface MicNodes {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  splitter: ChannelSplitterNode | null;
}

interface MicChain {
  trim: GainNode;
  analyser: AnalyserNode;
  fader: GainNode;
  monitor: GainNode;
  active: MicNodes | null;
  buffer: Float32Array<ArrayBuffer>;
}

export class LoadAbortedError extends Error {
  constructor() { super('Load superseded'); this.name = 'LoadAbortedError'; }
}

export function describeMicError(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone permission was denied. Allow microphone access for this site in the browser address bar or site settings, then enable the input again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No matching audio input was found. Connect the microphone or interface and choose it again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The audio input could not be opened. It may be in use by another app, or the operating system may be blocking access.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'That input is no longer available or cannot supply the requested channels. Pick the device again from the list.';
    case 'AbortError':
      return 'The browser stopped opening the audio input. Try again.';
    default:
      return e instanceof Error && e.message ? `The audio input failed: ${e.message}` : 'The audio input failed for an unknown reason.';
  }
}

type Listener = () => void;

export class AudioEngine {
  private snap: EngineSnapshot = INITIAL;
  private listeners = new Set<Listener>();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private backingNode: GainNode | null = null;
  private guideNode: GainNode | null = null;
  private chains: [MicChain, MicChain] | null = null;

  private backingBuf: AudioBuffer | null = null;
  private guideBuf: AudioBuffer | null = null;
  private sources: { backing: AudioBufferSourceNode; guide: AudioBufferSourceNode | null } | null = null;
  private offset = 0;
  private startedAt = 0;
  private playToken = 0;
  private loadSeq = 0;
  private loadAbort: AbortController | null = null;
  private initialised = false;
  private micSeq: [number, number] = [0, 0];

  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.snap;
  getServerSnapshot = () => INITIAL;

  private set(patch: Partial<EngineSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }
  private setMic(i: 0 | 1, patch: Partial<MicSnapshot>) {
    const mics: [MicSnapshot, MicSnapshot] = [this.snap.mics[0], this.snap.mics[1]];
    mics[i] = { ...mics[i], ...patch };
    this.set({ mics });
  }

  /** Call once on the client after mount. */
  init() {
    if (this.initialised || typeof window === 'undefined') return;
    this.initialised = true;
    const md = navigator.mediaDevices;
    this.set({ secureContext: window.isSecureContext, micSupported: window.isSecureContext && !!md?.getUserMedia });
    md?.addEventListener?.('devicechange', this.refreshDevices);
    void this.refreshDevices();
  }

  dispose() {
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.refreshDevices);
    this.unload();
    for (const i of [0, 1] as const) this.disableMic(i);
    void this.ctx?.close();
    this.ctx = null;
    this.chains = null;
    this.initialised = false;
  }

  refreshDevices = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
      const labelled = inputs.some((d) => d.label);
      this.set({
        devices: inputs.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Audio input ${i + 1}` })),
        devicesLabelled: labelled,
      });
    } catch { /* leave list as is */ }
  };

  // ---- context / graph ----------------------------------------------------

  /** Create or resume the context. Must be called synchronously inside a user gesture. */
  unlock(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.backingNode = ctx.createGain();
      this.guideNode = ctx.createGain();
      this.backingNode.connect(this.master);
      this.guideNode.connect(this.master);
      const mk = (): MicChain => {
        const trim = ctx.createGain();
        trim.channelCountMode = 'explicit';
        trim.channelCount = 1;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        const fader = ctx.createGain();
        const monitor = ctx.createGain();
        monitor.gain.value = 0;
        trim.connect(analyser);
        trim.connect(fader);
        fader.connect(monitor);
        monitor.connect(this.master!);
        return { trim, analyser, fader, monitor, active: null, buffer: new Float32Array(analyser.fftSize) };
      };
      this.chains = [mk(), mk()];
      ctx.addEventListener('statechange', () => this.syncContextInfo());
      this.applyGains();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.syncContextInfo();
    return this.ctx;
  }

  private syncContextInfo() {
    const c = this.ctx;
    if (!c) return;
    this.set({
      contextState: c.state,
      sampleRate: c.sampleRate,
      baseLatency: c.baseLatency ?? null,
      outputLatency: (c as AudioContext & { outputLatency?: number }).outputLatency ?? null,
    });
  }

  private ramp(param: AudioParam, v: number) {
    if (!this.ctx) return;
    param.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  private applyGains() {
    const s = this.snap;
    if (!this.ctx || !this.backingNode || !this.guideNode || !this.chains) return;
    this.ramp(this.backingNode.gain, s.backingMuted ? 0 : s.backingGain);
    this.ramp(this.guideNode.gain, s.guideMuted ? 0 : s.guideGain);
    for (const i of [0, 1] as const) {
      const m = s.mics[i];
      this.ramp(this.chains[i].fader.gain, m.muted ? 0 : m.gain);
      this.ramp(this.chains[i].monitor.gain, m.monitor && m.status === 'on' ? 1 : 0);
    }
  }

  setBackingGain(v: number) { this.set({ backingGain: v }); this.applyGains(); }
  setGuideGain(v: number) { this.set({ guideGain: v }); this.applyGains(); }
  setBackingMuted(v: boolean) { this.set({ backingMuted: v }); this.applyGains(); }
  setGuideMuted(v: boolean) { this.set({ guideMuted: v }); this.applyGains(); }

  // ---- track loading ------------------------------------------------------

  private async fetchBuffer(url: string, signal: AbortSignal, onBytes: (loaded: number, total: number) => void): Promise<ArrayBuffer | null> {
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Audio request failed (${res.status})`);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body) return res.arrayBuffer();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onBytes(loaded, total);
    }
    const out = new Uint8Array(loaded);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.byteLength; }
    return out.buffer;
  }

  /** Fetch and decode both stems fully. Call inside a user gesture the first time. */
  async load(trackId: string): Promise<void> {
    const ctx = this.unlock();
    this.stopSources();
    this.loadAbort?.abort();
    const abort = new AbortController();
    this.loadAbort = abort;
    const seq = ++this.loadSeq;
    this.backingBuf = null;
    this.guideBuf = null;
    this.offset = 0;
    this.set({ transport: 'loading', trackId, duration: 0, loadProgress: 0, loadStage: 'Downloading audio', hasGuide: false, error: null });
    const progress = [0, 0];
    const report = (i: number) => (loaded: number, total: number) => {
      if (seq !== this.loadSeq) return;
      progress[i] = total ? Math.min(1, loaded / total) : 0;
      this.set({ loadProgress: (progress[0] + progress[1]) / 2 * 0.8 });
    };
    try {
      const [backingRaw, guideRaw] = await Promise.all([
        this.fetchBuffer(`/api/media/${encodeURIComponent(trackId)}/backing`, abort.signal, report(0)),
        this.fetchBuffer(`/api/media/${encodeURIComponent(trackId)}/guide`, abort.signal, report(1)).catch((e) => {
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          return null;
        }),
      ]);
      if (seq !== this.loadSeq) throw new LoadAbortedError();
      if (!backingRaw) throw new Error('The backing track is not available for this song yet.');
      this.set({ loadStage: 'Decoding audio', loadProgress: 0.85 });
      const [backing, guide] = await Promise.all([
        ctx.decodeAudioData(backingRaw),
        guideRaw ? ctx.decodeAudioData(guideRaw).catch(() => null) : Promise.resolve(null),
      ]);
      if (seq !== this.loadSeq) throw new LoadAbortedError();
      this.backingBuf = backing;
      this.guideBuf = guide;
      this.set({ transport: 'ready', duration: backing.duration, loadProgress: 1, loadStage: '', hasGuide: !!guide });
    } catch (e) {
      if (e instanceof LoadAbortedError || (e instanceof DOMException && e.name === 'AbortError')) {
        throw new LoadAbortedError();
      }
      if (seq === this.loadSeq) {
        const msg = e instanceof Error && e.name === 'EncodingError'
          ? 'This browser could not decode the audio file.'
          : e instanceof Error ? e.message : 'Audio failed to load.';
        this.set({ transport: 'error', error: msg, loadStage: '' });
        throw new Error(msg);
      }
      throw new LoadAbortedError();
    }
  }

  /** Stop playback and free decoded buffers. */
  unload() {
    this.loadSeq++;
    this.loadAbort?.abort();
    this.loadAbort = null;
    this.stopSources();
    this.backingBuf = null;
    this.guideBuf = null;
    this.offset = 0;
    this.set({ transport: 'idle', trackId: null, duration: 0, loadProgress: 0, loadStage: '', hasGuide: false, error: null });
  }

  // ---- transport ----------------------------------------------------------

  private stopSources() {
    this.playToken++;
    const s = this.sources;
    this.sources = null;
    if (!s) return;
    for (const n of [s.backing, s.guide]) {
      if (!n) continue;
      n.onended = null;
      try { n.stop(); } catch { /* not started */ }
      n.disconnect();
    }
  }

  private startSources(at: number) {
    const ctx = this.ctx;
    if (!ctx || !this.backingBuf || !this.backingNode || !this.guideNode) return;
    this.stopSources();
    const token = this.playToken;
    // Both sources share one scheduled start time on the same clock.
    const when = ctx.currentTime + 0.06;
    const backing = ctx.createBufferSource();
    backing.buffer = this.backingBuf;
    backing.connect(this.backingNode);
    let guide: AudioBufferSourceNode | null = null;
    if (this.guideBuf) {
      guide = ctx.createBufferSource();
      guide.buffer = this.guideBuf;
      guide.connect(this.guideNode);
    }
    backing.onended = () => {
      if (token !== this.playToken) return;
      this.sources = null;
      this.offset = this.snap.duration;
      this.set({ transport: 'ended' });
    };
    backing.start(when, at);
    guide?.start(when, Math.min(at, this.guideBuf!.duration));
    this.sources = { backing, guide };
    this.offset = at;
    this.startedAt = when;
  }

  getPosition(): number {
    const { transport, duration } = this.snap;
    if (transport === 'ended') return duration;
    if (transport === 'playing' && this.ctx) {
      return Math.min(duration, Math.max(this.offset, this.offset + this.ctx.currentTime - this.startedAt));
    }
    return this.offset;
  }

  play() {
    const t = this.snap.transport;
    if (!this.backingBuf || !(t === 'ready' || t === 'paused' || t === 'ended')) return;
    this.unlock();
    this.startSources(t === 'ended' ? 0 : this.offset);
    this.set({ transport: 'playing' });
  }

  pause() {
    if (this.snap.transport !== 'playing') return;
    const pos = this.getPosition();
    this.stopSources();
    this.offset = pos;
    this.set({ transport: 'paused' });
  }

  seek(seconds: number) {
    const { transport, duration } = this.snap;
    if (!this.backingBuf || !(transport === 'playing' || transport === 'paused' || transport === 'ready' || transport === 'ended')) return;
    const t = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.05));
    if (transport === 'playing') {
      this.startSources(t);
    } else {
      this.offset = t;
      if (transport === 'ended') this.set({ transport: 'paused' });
      else this.set({});
    }
  }

  // ---- microphones --------------------------------------------------------

  setMicDevice(i: 0 | 1, deviceId: string) {
    this.setMic(i, { deviceId });
    if (this.snap.mics[i].status === 'on' || this.snap.mics[i].status === 'starting') void this.enableMic(i);
  }

  setMicMode(i: 0 | 1, mode: ChannelMode) {
    this.setMic(i, { mode });
    if (this.snap.mics[i].status === 'on') this.wireMic(i);
  }

  setMicGain(i: 0 | 1, gain: number) { this.setMic(i, { gain }); this.applyGains(); }
  setMicMuted(i: 0 | 1, muted: boolean) { this.setMic(i, { muted }); this.applyGains(); }
  setMicMonitor(i: 0 | 1, monitor: boolean) { this.setMic(i, { monitor }); this.applyGains(); }

  /** Must be called from a user gesture. */
  async enableMic(i: 0 | 1): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.setMic(i, {
        status: 'error',
        error: 'Microphone capture needs a secure page. Open the app from http://localhost on the host computer, or serve it over trusted HTTPS on the local network.',
      });
      return;
    }
    this.unlock();
    this.disableMic(i, true);
    const attempt = this.micSeq[i];
    this.setMic(i, { status: 'starting', error: null });
    const m = this.snap.mics[i];
    try {
      const audio: MediaTrackConstraints = {
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      if (m.deviceId) audio.deviceId = { exact: m.deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      if (attempt !== this.micSeq[i] || !this.ctx || !this.chains) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const track = stream.getAudioTracks()[0];
      if (!track) throw new DOMException('No audio track', 'NotFoundError');
      const source = this.ctx!.createMediaStreamSource(stream);
      this.chains![i].active = { stream, source, splitter: null };
      track.addEventListener('ended', () => {
        if (this.chains![i].active?.stream !== stream) return;
        this.disableMic(i, true);
        this.setMic(i, {
          status: 'error',
          error: 'The audio input was disconnected or taken away by the system. Reconnect it, then enable the input again.',
        });
      });
      const settings = track.getSettings();
      this.setMic(i, {
        status: 'on', error: null, label: track.label || null,
        channels: settings.channelCount ?? null,
        deviceId: m.deviceId || settings.deviceId || '',
      });
      this.wireMic(i);
      this.applyGains();
      void this.refreshDevices();
    } catch (e) {
      if (attempt !== this.micSeq[i]) return;
      this.setMic(i, { status: 'error', error: describeMicError(e), label: null, channels: null });
    }
  }

  disableMic(i: 0 | 1, keepStatus = false) {
    this.micSeq[i]++;
    const chain = this.chains?.[i];
    const a = chain?.active;
    if (a) {
      a.source.disconnect();
      a.splitter?.disconnect();
      a.stream.getTracks().forEach((t) => t.stop());
      chain!.active = null;
    }
    if (!keepStatus) {
      this.setMic(i, { status: 'off', error: null, label: null, channels: null });
      this.applyGains();
    }
  }

  private wireMic(i: 0 | 1) {
    const chain = this.chains![i];
    const a = chain.active;
    if (!a || !this.ctx) return;
    a.source.disconnect();
    a.splitter?.disconnect();
    a.splitter = null;
    const mode = this.snap.mics[i].mode;
    const channels = a.stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1;
    chain.trim.channelCount = mode === 'stereo' ? 2 : 1;
    if ((mode === 'left' || mode === 'right') && channels >= 2) {
      const splitter = this.ctx.createChannelSplitter(2);
      a.source.connect(splitter);
      splitter.connect(chain.trim, mode === 'left' ? 0 : 1);
      a.splitter = splitter;
    } else {
      // 'mix', or a single-channel device where left/right selection cannot apply.
      a.source.connect(chain.trim);
    }
  }

  getMicLevel(i: 0 | 1): number {
    const chain = this.chains?.[i];
    if (!chain || !chain.active) return 0;
    chain.analyser.getFloatTimeDomainData(chain.buffer);
    let sum = 0;
    for (let k = 0; k < chain.buffer.length; k++) sum += chain.buffer[k] * chain.buffer[k];
    return Math.sqrt(sum / chain.buffer.length);
  }
}

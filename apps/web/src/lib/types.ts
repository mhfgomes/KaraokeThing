export type PreparationStatus = 'queued' | 'running' | 'ready' | 'failed' | 'canceled';
export interface LyricWord { text: string; start: number; end?: number }
export interface LyricLine { text: string; start: number; end?: number; words?: LyricWord[] }
export interface Lyrics {
  kind: 'word' | 'line' | 'plain' | 'missing';
  lines: LyricLine[];
  plain: string;
  provider?: string;
  providerId?: number;
  attribution?: string;
  alignment?: { model: string; language?: string; alignedLines?: number; totalLines?: number; createdAt?: string };
}
export interface AlignmentState {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  progress: number;
  error: string | null;
}
export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  status: PreparationStatus;
  favorite: boolean;
  progress: number;
  error: string | null;
  quality: 'balanced' | 'high';
  lyrics: Lyrics;
  lyricOffset: number;
  createdAt: string;
  bytes: number;
  alignment?: AlignmentState;
}
export interface QueueEntry { id: string; trackId: string; singer: string; position: number }
export interface AppState {
  wordAlignmentEnabled?: boolean;
  admin: boolean;
  setupRequired: boolean;
  tracks: Track[];
  total: number;
  queue: QueueEntry[];
  active: { trackId: string; controller: string; expiresAt: number } | null;
  storageBytes: number;
  importRoots: string[];
  worker: { online: boolean; processing: boolean; modelReady: boolean; modelError: string | null };
}
export interface LyricMatch { id: number; trackName: string; artistName: string; albumName: string; duration: number; plainLyrics?: string | null; syncedLyrics?: string | null; lyricsfile?: unknown }

// ---- stage display -----------------------------------------------------------
/** Lease controller and owner used while the stage display plays a song. */
export const STAGE_CONTROLLER = 'stage-display';
export type StageMicMode = 'mix' | 'left' | 'right' | 'stereo';
export interface StageMicConfig { enabled: boolean; deviceId: string; mode: StageMicMode; gain: number; muted: boolean; monitor: boolean }
/** What the admin wants the stage display to do. `transportRev` changes only for load/play/pause/seek/stop. */
export interface StageDesired {
  trackId: string | null;
  singer: string | null;
  transportRev: number;
  playing: boolean;
  position: number;
  backingGain: number;
  guideGain: number;
  backingMuted: boolean;
  guideMuted: boolean;
  mics: [StageMicConfig, StageMicConfig];
  showSinger: boolean;
  showNextUp: boolean;
}
/** What the stage display last said it is doing. */
export interface StageReport {
  at: number;
  trackId: string | null;
  transport: 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';
  position: number;
  duration: number;
  loadProgress: number;
  error: string | null;
  hasGuide: boolean;
  soundBlocked: boolean;
  micSupported: boolean | null;
  devices: { deviceId: string; label: string }[];
  mics: { status: 'off' | 'starting' | 'on' | 'error'; error: string | null; label: string | null }[];
}
export interface StageFeed { desired: StageDesired; nextUp: string | null }
export interface StageAdminState { desired: StageDesired; report: StageReport | null; connected: boolean; key: string; now: number }

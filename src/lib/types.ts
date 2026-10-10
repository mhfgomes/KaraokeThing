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

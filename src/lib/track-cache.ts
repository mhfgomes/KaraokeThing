import type { Track } from './types';

/** Resolves to the track, or null when the server says it no longer exists (404). */
export type TrackFetcher = (id: string) => Promise<Track | null>;
export interface WantedTrack { id: string; maxAgeMs: number }

const RETRY_MS = 5000;
const KEEP_UNWANTED_MS = 60_000;

/**
 * Keeps songs referenced by the queue or the stage fresh even when they are not on the
 * visible library page. Each id is fetched on its own, so one failure never blocks the rest,
 * and 404s are remembered instead of being retried forever.
 */
export class TrackCache {
  private tracks = new Map<string, Track>();
  private fetchedAt = new Map<string, number>();
  private failedAt = new Map<string, number>();
  private gone = new Set<string>();
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(private fetchTrack: TrackFetcher, private now: () => number = Date.now) {}

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;
  private changed() { this.version++; this.listeners.forEach((l) => l()); }

  get(id: string): Track | undefined { return this.tracks.get(id); }
  isGone(id: string): boolean { return this.gone.has(id); }

  /** Record tracks the server just returned (library page, dialogs). */
  seen(tracks: Track[]) {
    if (!tracks.length) return;
    const at = this.now();
    for (const t of tracks) { this.tracks.set(t.id, t); this.fetchedAt.set(t.id, at); this.gone.delete(t.id); this.failedAt.delete(t.id); }
    this.changed();
  }

  /** Apply a change the server has confirmed, without waiting for a refetch. */
  patch(id: string, change: Partial<Track>) {
    const t = this.tracks.get(id);
    if (t) { this.tracks.set(id, { ...t, ...change }); this.changed(); }
  }

  /** Force the next sync to refetch this id. */
  invalidate(id: string) { this.fetchedAt.delete(id); this.gone.delete(id); this.failedAt.delete(id); }

  /** Fetch every wanted id that is missing or older than its max age; forget ids nobody has wanted for a while. */
  sync(wanted: WantedTrack[]) {
    const ids = new Set(wanted.map((w) => w.id));
    const at = this.now();
    for (const id of [...this.tracks.keys()]) {
      if (!ids.has(id) && at - (this.fetchedAt.get(id) ?? -Infinity) > KEEP_UNWANTED_MS) { this.tracks.delete(id); this.fetchedAt.delete(id); }
    }
    for (const id of [...this.gone]) if (!ids.has(id)) this.gone.delete(id);
    for (const id of [...this.failedAt.keys()]) if (!ids.has(id)) this.failedAt.delete(id);
    for (const { id, maxAgeMs } of wanted) {
      if (this.inflight.has(id) || this.gone.has(id)) continue;
      if (at - (this.failedAt.get(id) ?? -Infinity) < RETRY_MS) continue;
      const fetched = this.fetchedAt.get(id);
      if (fetched !== undefined && at - fetched < maxAgeMs) continue;
      void this.load(id);
    }
  }

  private async load(id: string) {
    this.inflight.add(id);
    try {
      const track = await this.fetchTrack(id);
      if (track) { this.tracks.set(id, track); this.fetchedAt.set(id, this.now()); this.failedAt.delete(id); }
      else { this.tracks.delete(id); this.fetchedAt.delete(id); this.gone.add(id); }
      this.changed();
    } catch {
      this.failedAt.set(id, this.now());
    } finally {
      this.inflight.delete(id);
    }
  }
}

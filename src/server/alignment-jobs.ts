import { randomUUID } from 'node:crypto';
import type { Lyrics } from '../lib/types';
import { db, getTrack, transaction } from './db';
import { HttpError } from './auth';

export function wordAlignmentEnabled(): boolean {
  return process.env.KARAOKE_EXPERIMENTAL_WORD_ALIGNMENT === '1';
}

export function needsAlignment(lyrics: Lyrics): boolean {
  return lyrics.lines.some(line => line.text.trim() && !line.words?.length);
}

export function queueAlignment(trackId: string, retry = false): boolean {
  if (!wordAlignmentEnabled()) {
    if (retry) throw new HttpError(409, 'Experimental word alignment is disabled. Existing lyric timing is preserved.');
    return false;
  }
  return transaction(() => {
    const track = getTrack(trackId);
    if (!track) throw new HttpError(404, 'Song not found.');
    if (!track.guide) throw new HttpError(409, 'Prepare the guide vocal before generating word timings.');
    const lyrics = JSON.parse(track.lyrics) as Lyrics;
    if (!lyrics.lines.length || !needsAlignment(lyrics)) {
      if (retry) throw new HttpError(409, lyrics.kind === 'word' ? 'This song already has word timings.' : 'Choose synchronized line lyrics before generating word timings.');
      return false;
    }
    const existing = db.prepare("SELECT id,lyrics_snapshot,guide_snapshot FROM alignment_jobs WHERE track_id=? AND status IN ('queued','running')").get(trackId) as { id: string; lyrics_snapshot: string; guide_snapshot: string } | undefined;
    if (existing && !retry && existing.lyrics_snapshot === track.lyrics && existing.guide_snapshot === track.guide) return false;
    const now = new Date().toISOString();
    if (existing) db.prepare("UPDATE alignment_jobs SET status='canceled',updated_at=? WHERE id=?").run(now, existing.id);
    db.prepare('INSERT INTO alignment_jobs(id,track_id,lyrics_snapshot,guide_snapshot,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), trackId, track.lyrics, track.guide, now, now);
    return true;
  });
}

export function cancelAlignment(trackId: string) {
  db.prepare("UPDATE alignment_jobs SET status='canceled',updated_at=? WHERE track_id=? AND status IN ('queued','running')").run(new Date().toISOString(), trackId);
}

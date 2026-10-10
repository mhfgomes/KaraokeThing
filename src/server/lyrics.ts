import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Lyrics, LyricLine, LyricWord, LyricMatch } from '../lib/types';

export function parseLrc(text: string): LyricLine[] {
  let offset = Number(/\[offset:([+-]?\d+)\]/i.exec(text)?.[1] || 0) / 1000;
  if (!Number.isFinite(offset)) offset = 0;
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const times = [...raw.matchAll(/\[(\d+):(\d{2}(?:\.\d+)?)\]/g)];
    if (!times.length) continue;
    const content = raw.replace(/\[\d+:\d{2}(?:\.\d+)?\]/g, '').trim();
    // Enhanced LRC word timestamps are real timing data, never interpolated.
    const wordTokens = [...content.matchAll(/<(\d+):(\d{2}(?:\.\d+)?)>([^<]*)/g)];
    const words: LyricWord[] = wordTokens.map((m, i) => ({ text: m[3], start: Number(m[1]) * 60 + Number(m[2]) + offset,
      ...(wordTokens[i + 1] ? { end: Number(wordTokens[i + 1][1]) * 60 + Number(wordTokens[i + 1][2]) + offset } : {}) }));
    for (const match of times) lines.push({ start: Math.max(0, Number(match[1]) * 60 + Number(match[2]) + offset), text: content.replace(/<\d+:\d{2}(?:\.\d+)?>/g, ''), ...(words.length ? { words } : {}) });
  }
  lines.sort((a, b) => a.start - b.start);
  for (let i = 0; i < lines.length - 1; i++) lines[i].end = lines[i + 1].start;
  return lines;
}
const lyricWordSchema = z.object({ text: z.string(), start_ms: z.number().nonnegative(), end_ms: z.number().nonnegative().optional() });
const lyricFileSchema = z.object({ lines: z.array(z.object({ text: z.string().optional(), start_ms: z.number().nonnegative(), end_ms: z.number().nonnegative().optional(), words: z.array(lyricWordSchema).optional() })).max(10000) });
export function normalizeLyrics(match: LyricMatch): Lyrics {
  let lines: LyricLine[] = [];
  if (match.lyricsfile) {
    try {
      const input = typeof match.lyricsfile === 'string' ? parseYaml(match.lyricsfile, { maxAliasCount: 0 }) : match.lyricsfile;
      const file = lyricFileSchema.safeParse(input);
      if (file.success) lines = file.data.lines.map(line => ({ start: line.start_ms / 1000, ...(line.end_ms !== undefined ? { end: line.end_ms / 1000 } : {}),
        text: line.text || line.words?.map(w => w.text).join('') || '', words: line.words?.map(w => ({ text: w.text, start: w.start_ms / 1000, ...(w.end_ms !== undefined ? { end: w.end_ms / 1000 } : {}) })) })).sort((a, b) => a.start - b.start);
    } catch { /* fall back to conventional LRC */ }
  }
  if (!lines.length && match.syncedLyrics) lines = parseLrc(match.syncedLyrics);
  const plain = match.plainLyrics || lines.map(line => line.text).join('\n');
  return { kind: lines.length ? (lines.some(line => line.words?.length) ? 'word' : 'line') : plain ? 'plain' : 'missing', lines, plain,
    provider: 'LRCLIB', providerId: match.id, attribution: 'Lyrics from LRCLIB' };
}
const matchSchema = z.object({ id: z.number(), trackName: z.string(), artistName: z.string(), albumName: z.string().default(''), duration: z.number(), plainLyrics: z.string().nullable().optional(), syncedLyrics: z.string().nullable().optional(), lyricsfile: z.unknown().optional() });
async function providerFetch(endpoint: string, query?: URLSearchParams) {
  const url = `https://lrclib.net/api/${endpoint}${query ? `?${query}` : ''}`;
  const response = await fetch(url, { headers: { 'User-Agent': 'KaraokeThing/0.1 (local personal karaoke)' }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(response.status === 404 ? 'No matching lyrics were found.' : `Lyric provider returned ${response.status}. Try again later.`);
  return response.json();
}
export async function lookupLyrics(track: { title: string; artist: string; album: string; duration: number }) {
  const query = new URLSearchParams({ track_name: track.title, artist_name: track.artist, duration: String(Math.round(track.duration)) });
  if (track.album) query.set('album_name', track.album);
  return normalizeLyrics(matchSchema.parse(await providerFetch('get', query)));
}
export async function searchLyrics(title: string, artist: string): Promise<LyricMatch[]> {
  const query = new URLSearchParams({ track_name: title });
  if (artist !== 'Unknown artist' && artist) query.set('artist_name', artist);
  return z.array(matchSchema).parse(await providerFetch('search', query)).slice(0, 20);
}
export async function selectLyrics(id: number) { return normalizeLyrics(matchSchema.parse(await providerFetch(`get/${id}`))); }

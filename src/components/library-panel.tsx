'use client';

import { Input } from '@/components/ui/input';
import { ChevronLeft, ChevronRight, ListPlus, Pencil, Play, Search, Star } from 'lucide-react';
import type { Track } from '@/lib/types';
import { formatTime } from '@/lib/client-api';
import { LyricsChip, StatusChip } from './ui-bits';

interface Props {
  tracks: Track[];
  total: number;
  page: number;
  pageSize: number;
  q: string;
  onQ: (q: string) => void;
  favoritesOnly: boolean;
  onFavoritesOnly: (v: boolean) => void;
  onPage: (p: number) => void;
  admin: boolean;
  loaded: boolean;
  playingId: string | null;
  playDisabledReason: string | null;
  onPlay: (t: Track) => void;
  onQueue: (t: Track) => void;
  onEdit: (t: Track) => void;
  onFavorite: (t: Track) => void;
  onGoAdd: () => void;
}

export function LibraryPanel(p: Props) {
  const pages = Math.max(1, Math.ceil(p.total / p.pageSize));
  const filtering = !!p.q.trim() || p.favoritesOnly;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <label htmlFor="lib-search" className="sr-only">Search songs by title or artist</label>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="lib-search" type="search" className="field" style={{ paddingLeft: '2.25rem' }} placeholder="Search title or artist" value={p.q} onChange={(e) => p.onQ(e.target.value)} />
        </div>
        <button className={`btn btn-icon ${p.favoritesOnly ? 'btn-primary' : ''}`} aria-pressed={p.favoritesOnly} onClick={() => p.onFavoritesOnly(!p.favoritesOnly)} aria-label="Show favorites only" title="Favorites only">
          <Star size={16} fill={p.favoritesOnly ? 'currentColor' : 'none'} />
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
        {!p.loaded ? (
          <p className="p-4 text-center text-sm text-muted-foreground" role="status">Loading library…</p>
        ) : p.tracks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/20 p-5 text-center">
            {filtering ? (
              <>
                <p className="font-display text-xl font-bold">No songs match</p>
                <p className="mt-1 text-sm text-muted-foreground">Try a different title or artist{p.favoritesOnly ? ', or turn off the favorites filter' : ''}.</p>
              </>
            ) : (
              <>
                <p className="font-display text-xl font-bold">The library is empty</p>
                <p className="mt-1 text-sm text-muted-foreground">{p.admin ? 'Upload audio files or import a folder. Each song is separated into backing and guide tracks before it can be sung.' : 'The host has not added any songs yet.'}</p>
                {p.admin && <button className="btn btn-primary mt-3" onClick={p.onGoAdd}>Add songs</button>}
              </>
            )}
          </div>
        ) : (
          <ul className="space-y-2">
            {p.tracks.map((t) => {
              const ready = t.status === 'ready';
              return (
                <li key={t.id} className={`panel p-3 ${p.playingId === t.id ? 'row-live' : ''}`} aria-current={p.playingId === t.id ? 'true' : undefined}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="lib-title truncate">{t.title}</p>
                      <p className="truncate text-sm text-muted-foreground">{t.artist || 'Unknown artist'} · {formatTime(t.duration)}</p>
                    </div>
                    {p.admin ? (
                      <button className="btn btn-ghost btn-icon btn-sm" aria-pressed={t.favorite} aria-label={`${t.favorite ? 'Remove' : 'Add'} ${t.title} ${t.favorite ? 'from' : 'to'} favorites`} onClick={() => p.onFavorite(t)}>
                        <Star size={16} className={t.favorite ? 'text-gold' : ''} fill={t.favorite ? 'currentColor' : 'none'} />
                      </button>
                    ) : t.favorite ? <Star size={16} className="mt-1 text-gold" fill="currentColor" aria-label="Favorite" /> : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <StatusChip track={t} />
                    <LyricsChip track={t} />
                  </div>
                  {t.status === 'running' && (
                    <div className="meter mt-2" role="progressbar" aria-label={`Preparing ${t.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(t.progress * 100)}><i style={{ width: `${Math.round(t.progress * 100)}%` }} /></div>
                  )}
                  {t.status === 'failed' && t.error && <p className="mt-1 line-clamp-2 text-xs text-[#ffb0c0]">{t.error}</p>}
                  {p.admin && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-white/10 pt-2.5">
                      <button className="btn btn-primary btn-sm" disabled={!ready || !!p.playDisabledReason} title={p.playDisabledReason ?? (ready ? undefined : 'Not ready yet')} onClick={() => p.onPlay(t)}><Play size={13} /> Sing now</button>
                      <button className="btn btn-sm" disabled={!ready} onClick={() => p.onQueue(t)}><ListPlus size={13} /> Queue</button>
                      <button className="btn btn-sm" onClick={() => p.onEdit(t)}><Pencil size={13} /> Details</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {p.loaded && p.total > p.pageSize && (
        <nav className="flex items-center justify-between gap-2" aria-label="Library pages">
          <button className="btn btn-sm" onClick={() => p.onPage(p.page - 1)} disabled={p.page <= 1}><ChevronLeft size={14} /> Previous</button>
          <span className="text-xs text-muted-foreground" aria-live="polite">Page {p.page} of {pages} · {p.total} songs</span>
          <button className="btn btn-sm" onClick={() => p.onPage(p.page + 1)} disabled={p.page >= pages}>Next <ChevronRight size={14} /></button>
        </nav>
      )}
      {p.loaded && p.total > 0 && p.total <= p.pageSize && <p className="text-center text-xs text-muted-foreground">{p.total} song{p.total === 1 ? '' : 's'}</p>}
    </div>
  );
}

'use client';

import { Input } from '@/components/ui/input';
import { ChevronLeft, ChevronRight, Info, ListPlus, Pencil, Play, Search, Star } from 'lucide-react';
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

// Shown on the card: disabled buttons never show a tooltip, and touch screens have none.
const notReady = (t: Track) => t.status === 'failed' ? t.error || 'Preparation failed.'
  : t.status === 'canceled' ? 'Preparation was canceled.' : 'Sing and Queue unlock once it is prepared.';

// Compact icon buttons; full 44px targets on touch screens.
const act = 'btn btn-sm btn-icon min-h-8 min-w-8 p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11';

export function LibraryPanel(p: Props) {
  const pages = Math.max(1, Math.ceil(p.total / p.pageSize));
  const filtering = !!p.q.trim() || p.favoritesOnly;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <label htmlFor="lib-search" className="sr-only">Search songs by title or artist</label>
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="lib-search" type="search" className="field pl-9" placeholder="Search title or artist" value={p.q} onChange={(e) => p.onQ(e.target.value)} />
        </div>
        <button className={`btn btn-icon ${p.favoritesOnly ? 'btn-primary' : ''}`} aria-pressed={p.favoritesOnly} onClick={() => p.onFavoritesOnly(!p.favoritesOnly)} aria-label="Show favorites only" title="Favorites only">
          <Star size={16} fill={p.favoritesOnly ? 'currentColor' : 'none'} />
        </button>
      </div>

      {p.admin && p.playDisabledReason && (
        <p id="lib-play-why" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Info size={14} className="shrink-0" aria-hidden />Sing now is paused: {p.playDisabledReason}</p>
      )}

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
                <p className="mt-1 text-sm text-muted-foreground">{p.admin ? 'Open the Add songs tab above to upload audio files or import a folder. Each song is separated into backing and guide tracks before it can be sung.' : 'The host has not added any songs yet.'}</p>
              </>
            )}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {p.tracks.map((t) => {
              const ready = t.status === 'ready';
              const why = ready ? undefined : `lib-why-${t.id}`;
              const playWhy = [why, p.playDisabledReason && 'lib-play-why'].filter(Boolean).join(' ') || undefined;
              return (
                <li key={t.id} className={`panel grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-xl px-3 py-2 ${p.playingId === t.id ? 'row-live' : ''}`} aria-current={p.playingId === t.id ? 'true' : undefined}>
                  <p className="lib-title col-span-2 truncate pointer-coarse:line-clamp-2 pointer-coarse:whitespace-normal" title={t.title}>{t.title}</p>
                  <div className={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground [&>.chip]:shrink-0 ${p.admin ? '' : 'col-span-2'}`}>
                    <span className="max-w-full truncate" title={t.artist || undefined}>{t.artist || 'Unknown artist'} · {formatTime(t.duration)}</span>
                    {!ready && <StatusChip track={t} />}
                    <LyricsChip track={t} />
                    {!p.admin && t.favorite && <Star size={13} className="shrink-0 text-gold" fill="currentColor" aria-label="Favorite" />}
                  </div>
                  {p.admin && (
                    <div className="flex gap-1">
                      <button className={`${act} btn-primary`} disabled={!ready || !!p.playDisabledReason} aria-label={`Sing ${t.title} now`} aria-describedby={playWhy} title="Sing now" onClick={() => p.onPlay(t)}><Play size={15} /></button>
                      <button className={act} disabled={!ready} aria-label={`Queue ${t.title}`} aria-describedby={why} title="Add to queue" onClick={() => p.onQueue(t)}><ListPlus size={15} /></button>
                      <button className={act} aria-label={`Details for ${t.title}`} title="Details" onClick={() => p.onEdit(t)}><Pencil size={15} /></button>
                      <button className={`${act} btn-ghost`} aria-pressed={t.favorite} aria-label={`${t.favorite ? 'Remove' : 'Add'} ${t.title} ${t.favorite ? 'from' : 'to'} favorites`} title="Favorite" onClick={() => p.onFavorite(t)}>
                        <Star size={15} className={t.favorite ? 'text-gold' : ''} fill={t.favorite ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                  )}
                  {t.status === 'running' && (
                    <div className="meter col-span-2 mt-1" role="progressbar" aria-label={`Preparing ${t.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(t.progress * 100)}><i style={{ width: `${Math.round(t.progress * 100)}%` }} /></div>
                  )}
                  {p.admin && why ? <p id={why} className={`col-span-2 line-clamp-2 text-xs ${t.status === 'failed' ? 'text-[#ffb0c0]' : 'text-muted-foreground'}`}>{notReady(t)}</p>
                    : t.status === 'failed' && t.error && <p className="col-span-2 line-clamp-2 text-xs text-[#ffb0c0]">{t.error}</p>}
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

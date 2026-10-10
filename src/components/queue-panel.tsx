'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Play, X } from 'lucide-react';
import type { QueueEntry, Track } from '@/lib/types';
import { formatTime } from '@/lib/client-api';

interface Props {
  queue: QueueEntry[];
  trackFor: (id: string) => Track | undefined;
  isGone?: (id: string) => boolean;
  admin: boolean;
  startDisabledReason: string | null;
  onStart: (entry: QueueEntry) => void;
  onRemove: (entry: QueueEntry) => void;
  onReorder: (ids: string[]) => void;
}

export function QueuePanel({ queue, trackFor, isGone, admin, startDisabledReason, onStart, onRemove, onReorder }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');

  const move = (from: number, to: number) => {
    if (to < 0 || to >= queue.length || from === to) return;
    const ids = queue.map((q) => q.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    onReorder(ids);
    const t = trackFor(queue[from].trackId);
    setAnnounce(`${queue[from].singer}${t ? `, ${t.title}` : ''} moved to position ${to + 1} of ${queue.length}`);
  };

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const from = queue.findIndex((q) => q.id === dragId);
    const to = queue.findIndex((q) => q.id === targetId);
    move(from, to);
  };

  if (queue.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/20 p-5 text-center">
        <p className="font-display text-xl font-bold">No singers waiting</p>
        <p className="mt-1 text-sm text-muted-foreground">{admin ? 'Pick a ready song in the library and add a singer name to build the queue.' : 'The host adds songs to the queue.'}</p>
      </div>
    );
  }

  return (
    <div>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      <ol className="space-y-2">
        {queue.map((q, i) => {
          const t = trackFor(q.trackId);
          const unavailable = !t || t.status !== 'ready';
          const gone = !t && !!isGone?.(q.trackId);
          return (
            <li
              key={q.id}
              className={`panel flex flex-wrap items-center gap-2 p-2.5 ${i === 0 ? 'row-next ' : ''}${overId === q.id && dragId !== q.id ? 'drag-over' : ''} ${dragId === q.id ? 'opacity-50' : ''}`}
              draggable={admin}
              onDragStart={(e) => { setDragId(q.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', q.id); }}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverId(q.id); } }}
              onDragLeave={() => setOverId((o) => (o === q.id ? null : o))}
              onDrop={(e) => { e.preventDefault(); drop(q.id); setDragId(null); setOverId(null); }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
            >
              {admin && (
                <button
                  className="btn btn-ghost btn-icon btn-sm cursor-grab touch-none"
                  aria-label={`Reorder ${q.singer}. Use arrow up and down keys.`}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1); }
                    if (e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1); }
                  }}
                >
                  <GripVertical size={16} />
                </button>
              )}
              <span className="pos" aria-label={i === 0 ? "Position 1, up next" : `Position ${i + 1}`}>{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-xl font-bold leading-tight text-coral">{q.singer}</p>
                <p className="truncate text-sm font-semibold leading-tight">{t ? t.title : gone ? 'Song removed from the library' : 'Loading song details…'}</p>
                <p className="truncate text-xs text-muted-foreground">{t ? `${t.artist} · ${formatTime(t.duration)}` : gone ? 'Remove this entry or pick another song' : ''}{t && t.status !== 'ready' ? ' · not ready' : ''}</p>
              </div>
              {admin && (
                <div className="flex w-full items-center justify-end gap-1 border-t border-white/10 pt-2">
                  <button className="btn btn-sm btn-icon" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${q.singer} up`}><ArrowUp size={14} /></button>
                  <button className="btn btn-sm btn-icon" onClick={() => move(i, i + 1)} disabled={i === queue.length - 1} aria-label={`Move ${q.singer} down`}><ArrowDown size={14} /></button>
                  <button
                    className="btn btn-primary btn-sm" onClick={() => onStart(q)} disabled={unavailable || !!startDisabledReason}
                    title={startDisabledReason ?? (unavailable ? 'This song is not ready' : 'Start this song now')}
                  >
                    <Play size={14} /> Start
                  </button>
                  <button className="btn btn-sm btn-icon" onClick={() => onRemove(q)} aria-label={`Remove ${q.singer} from the queue`}><X size={14} /></button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {admin && startDisabledReason && <p className="mt-2 text-xs text-muted-foreground">{startDisabledReason}</p>}
    </div>
  );
}

'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

type Ctl = 'grip' | 'up' | 'down';
// Where focus goes after a move, best first: the same control, else one still enabled and visible.
const FOCUS_ORDER: Record<Ctl, Ctl[]> = { grip: ['grip', 'up', 'down'], up: ['up', 'down', 'grip'], down: ['down', 'up', 'grip'] };
const tap = 'pointer-coarse:min-h-11 pointer-coarse:min-w-11';
// No hover tooltips on touch, so long names wrap to two lines there instead.
const clamp = 'pointer-coarse:line-clamp-2 pointer-coarse:whitespace-normal';

export function QueuePanel({ queue, trackFor, isGone, admin, startDisabledReason, onStart, onRemove, onReorder }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const refocus = useRef<{ id: string; ctl: Ctl } | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The moved row is re-inserted (and its edge button disabled), dropping focus; put it back before paint.
  useLayoutEffect(() => {
    const r = refocus.current;
    if (!r) return;
    refocus.current = null;
    for (const ctl of FOCUS_ORDER[r.ctl]) {
      const el = listRef.current?.querySelector<HTMLButtonElement>(`[data-entry="${CSS.escape(r.id)}"][data-ctl="${ctl}"]`);
      if (el && !el.disabled && el.offsetParent) { el.focus(); return; }
    }
  }, [queue]);

  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  const move = (from: number, to: number, ctl?: Ctl) => {
    if (to < 0 || to >= queue.length || from === to) return;
    const ids = queue.map((q) => q.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    if (ctl) refocus.current = { id, ctl };
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

  // Two taps to remove: the first arms the button, which disarms after a few seconds or on blur.
  const remove = (q: QueueEntry) => {
    clearTimeout(confirmTimer.current);
    if (confirmId === q.id) { setConfirmId(null); onRemove(q); return; }
    setConfirmId(q.id);
    setAnnounce(`Press remove again to take ${q.singer} off the queue`);
    confirmTimer.current = setTimeout(() => setConfirmId(null), 4000);
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
      <ol ref={listRef} className="space-y-2">
        {queue.map((q, i) => {
          const t = trackFor(q.trackId);
          const unavailable = !t || t.status !== 'ready';
          const gone = !t && !!isGone?.(q.trackId);
          const songLine = t ? t.title : gone ? 'Song removed from the library' : 'Loading song details…';
          const confirming = confirmId === q.id;
          return (
            <li
              key={q.id}
              className={`panel flex flex-wrap items-center gap-2 p-2.5 ${i === 0 ? 'row-next ' : ''}${overId === q.id && dragId !== q.id ? 'drag-over' : ''} ${dragId === q.id ? 'opacity-50' : ''}`}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverId(q.id); } }}
              onDragLeave={() => setOverId((o) => (o === q.id ? null : o))}
              onDrop={(e) => { e.preventDefault(); drop(q.id); setDragId(null); setOverId(null); }}
            >
              {admin && (
                // Mouse drag source and keyboard reorder handle; touch screens use the arrow buttons instead.
                <button
                  className="btn btn-ghost btn-icon btn-sm cursor-grab pointer-coarse:hidden"
                  data-entry={q.id} data-ctl="grip" draggable
                  aria-label={`Reorder ${q.singer}, position ${i + 1} of ${queue.length}. Use arrow up and down keys.`}
                  onDragStart={(e) => {
                    setDragId(q.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', q.id);
                    const row = e.currentTarget.closest('li');
                    if (row) e.dataTransfer.setDragImage(row, 16, 16);
                  }}
                  onDragEnd={() => { setDragId(null); setOverId(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp') { e.preventDefault(); move(i, i - 1, 'grip'); }
                    if (e.key === 'ArrowDown') { e.preventDefault(); move(i, i + 1, 'grip'); }
                  }}
                >
                  <GripVertical size={16} />
                </button>
              )}
              <span className="pos" aria-label={i === 0 ? "Position 1, up next" : `Position ${i + 1}`}>{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className={`truncate font-display text-xl font-bold leading-tight text-coral ${clamp}`} title={q.singer}>{q.singer}</p>
                <p className={`truncate text-sm font-semibold leading-tight ${clamp}`} title={songLine}>{songLine}</p>
                <p className={`truncate text-xs text-muted-foreground ${clamp}`} title={t?.artist || undefined}>{t ? `${t.artist} · ${formatTime(t.duration)}` : gone ? 'Remove this entry or pick another song' : ''}{t && t.status !== 'ready' ? ' · not ready' : ''}</p>
              </div>
              {admin && (
                <div className="flex w-full items-center justify-end gap-1 border-t border-white/10 pt-2">
                  <button className={`btn btn-sm btn-icon ${tap}`} data-entry={q.id} data-ctl="up" onClick={() => move(i, i - 1, 'up')} disabled={i === 0} aria-label={`Move ${q.singer} up`}><ArrowUp size={14} /></button>
                  <button className={`btn btn-sm btn-icon ${tap}`} data-entry={q.id} data-ctl="down" onClick={() => move(i, i + 1, 'down')} disabled={i === queue.length - 1} aria-label={`Move ${q.singer} down`}><ArrowDown size={14} /></button>
                  <button
                    className={`btn btn-primary btn-sm ${tap}`} onClick={() => onStart(q)} disabled={unavailable || !!startDisabledReason}
                    title={startDisabledReason ?? (unavailable ? 'This song is not ready' : 'Start this song now')} aria-describedby={startDisabledReason ? 'queue-start-why' : undefined}
                  >
                    <Play size={14} /> Start
                  </button>
                  <button
                    className={`btn btn-sm ${confirming ? 'btn-danger' : 'btn-icon'} ${tap}`}
                    onClick={() => remove(q)} onBlur={() => setConfirmId((c) => (c === q.id ? null : c))}
                    aria-label={confirming ? `Confirm removing ${q.singer} from the queue` : `Remove ${q.singer} from the queue`}
                  >
                    <X size={14} />{confirming && ' Remove?'}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {admin && startDisabledReason && <p id="queue-start-why" className="mt-2 text-xs text-muted-foreground">{startDisabledReason}</p>}
    </div>
  );
}

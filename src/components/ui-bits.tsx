'use client';

import { type ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { Track } from '@/lib/types';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Slider as UiSlider } from '@/components/ui/slider';

export function Modal({ open, onClose, title, description, children, wide }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-lg"
        style={wide ? { width: 'min(56rem, calc(100vw - 1.5rem))', maxWidth: 'calc(100vw - 1.5rem)' } : undefined}
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
          <div className="min-w-0">
            <DialogTitle className="font-display text-2xl font-bold leading-tight tracking-wide">{title}</DialogTitle>
            {description && <DialogDescription className="sr-only">{description}</DialogDescription>}
          </div>
          <DialogClose className="btn btn-ghost btn-icon" aria-label="Close dialog"><X size={18} /></DialogClose>
        </div>
        <div className="scroll-thin overflow-y-auto px-5 py-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function ErrorNote({ children, tone = 'error', id }: { children: ReactNode; tone?: 'error' | 'warn'; id?: string }) {
  if (!children) return null;
  return (
    <div id={id} role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${tone === 'error' ? 'border-[#ff7a7a66] bg-[#3a1226] text-[#ffd6dc]' : 'border-gold/40 bg-[#33280f] text-[#ffe9ab]'}`}>
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function Slider({ label, value, min = 0, max = 1, step = 0.01, onChange, onCommit, disabled, color, valueText, className }: {
  label: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; onCommit?: (v: number) => void;
  disabled?: boolean; color?: string; valueText?: string; className?: string;
}) {
  return (
    <UiSlider
      className={`min-w-0 flex-1 py-2 [&_[data-slot=slider-range]]:bg-[var(--fill)] [&_[data-slot=slider-thumb]]:border-[var(--fill)] [&_[data-slot=slider-thumb]]:size-4 [&_[data-slot=slider-track]]:bg-[#3a2a69] ${className ?? ''}`}
      style={{ ['--fill' as string]: color ?? '#7556e8' }}
      value={[value]} min={min} max={max} step={step} disabled={disabled}
      thumbProps={{ 'aria-label': label, getAriaValueText: valueText ? () => valueText : undefined }}
      onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      onValueCommitted={onCommit && ((v) => onCommit(Array.isArray(v) ? v[0] : v))}
    />
  );
}

export function StatusChip({ track }: { track: Track }) {
  switch (track.status) {
    case 'ready': return <span className="chip chip-mint">Ready</span>;
    case 'running': return <span className="chip chip-gold">Preparing {Math.round(track.progress * 100)}%</span>;
    case 'queued': return <span className="chip chip-violet">Waiting</span>;
    case 'failed': return <span className="chip chip-coral">Failed</span>;
    case 'canceled': return <span className="chip chip-dim">Canceled</span>;
  }
}

export function LyricsChip({ track }: { track: Track }) {
  switch (track.lyrics.kind) {
    case 'word': {
      const total = track.lyrics.lines.filter(line => line.text.trim()).length;
      const timed = track.lyrics.lines.filter(line => line.text.trim() && line.words?.length).length;
      return <span className="chip chip-mint" title={timed < total ? 'Word timing where available; other lines use line highlighting' : 'Word-by-word timing'}>{timed < total ? `Words ${timed}/${total} lines` : 'Words synced'}</span>;
    }
    case 'line': return <span className="chip chip-mint" title="Line-by-line timing">{track.alignment?.status === 'running' ? `Aligning words ${Math.round(track.alignment.progress * 100)}%` : track.alignment?.status === 'queued' ? 'Words queued' : 'Lines synced'}</span>;
    case 'plain': return <span className="chip chip-gold" title="Lyrics without timing">Plain lyrics</span>;
    case 'missing': return <span className="chip chip-dim">No lyrics</span>;
  }
}

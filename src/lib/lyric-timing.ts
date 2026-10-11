import type { LyricLine } from './types';

/** Word alignment can correct an approximate provider line start. */
export const lineStart = (line: LyricLine) => line.words?.[0]?.start ?? line.start;
export const isBlankLine = (line?: LyricLine | null) => !line || !line.text.trim();

export function currentLyricIndex(lines: LyricLine[], seconds: number): number {
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lineStart(lines[i]) <= seconds) index = i;
  }
  return index;
}

/** Neighbouring sung lines, skipping blank instrumental markers. */
export function sungLinesAfter(lines: LyricLine[], index: number, count: number): LyricLine[] {
  const out: LyricLine[] = [];
  for (let i = index + 1; i < lines.length && out.length < count; i++) if (!isBlankLine(lines[i])) out.push(lines[i]);
  return out;
}
export function sungLineBefore(lines: LyricLine[], index: number): LyricLine | null {
  for (let i = Math.min(index, lines.length) - 1; i >= 0; i--) if (!isBlankLine(lines[i])) return lines[i];
  return null;
}

/** Whole seconds until the next sung line during an intro or instrumental gap, once it is `within` seconds away. */
export function gapCountdown(lines: LyricLine[], index: number, seconds: number, within = 5): number | null {
  if (index >= 0 && !isBlankLine(lines[index])) return null;
  const next = sungLinesAfter(lines, index, 1)[0];
  if (!next) return null;
  const left = lineStart(next) - seconds;
  return left > 0 && left <= within ? Math.ceil(left) : null;
}

/** Fill fraction (0..1) of word `i`; an untimed end runs to the next word, then the line end. */
export function wordProgress(line: LyricLine, i: number, seconds: number): number {
  const words = line.words!;
  const w = words[i];
  const end = w.end ?? words[i + 1]?.start ?? line.end ?? w.start + 0.5;
  const raw = end > w.start ? (seconds - w.start) / (end - w.start) : seconds >= w.start ? 1 : 0;
  return Math.min(1, Math.max(0, raw));
}

/** Seconds between the audio clock and sound reaching the listener; Bluetooth/USB outputs can add hundreds of ms. */
export function outputDelaySeconds(baseLatency?: number | null, outputLatency?: number | null): number {
  const part = (v?: number | null) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return Math.min(1, part(baseLatency) + part(outputLatency));
}

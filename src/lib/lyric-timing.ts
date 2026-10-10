import type { LyricLine } from './types';

/** Word alignment can correct an approximate provider line start. */
export function currentLyricIndex(lines: LyricLine[], seconds: number): number {
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    const start = lines[i].words?.[0]?.start ?? lines[i].start;
    if (start <= seconds) index = i;
  }
  return index;
}

/** Seconds between the audio clock and sound reaching the listener; Bluetooth/USB outputs can add hundreds of ms. */
export function outputDelaySeconds(baseLatency?: number | null, outputLatency?: number | null): number {
  const part = (v?: number | null) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return Math.min(1, part(baseLatency) + part(outputLatency));
}
